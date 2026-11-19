const { z } = require("zod");
const env = require("../../config/env");
const { HttpError } = require("../../shared/http");

function assertConfigured() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Supabase is not configured");
  }
}

async function supabaseGet(path, params) {
  const url = new URL(path, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
      },
    });
  } catch {
    throw new HttpError(502, "Could not reach Supabase");
  }

  if (!response.ok) {
    throw new HttpError(502, "Could not load tenants");
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new HttpError(502, "Could not load tenants");
  }
  return rows;
}

function toTenant(tenant, propertyCount, staffCount, staffNames, parentName) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    licenseTier: tenant.license_tier,
    propertyLimit: tenant.max_property_licenses,
    propertyCount,
    staffCount,
    staffNames,
    parentOrganizationId: tenant.parent_organization_id,
    parentOrganizationName: parentName,
    createdAt: tenant.created_at,
  };
}

async function list() {
  assertConfigured();

  const [tenants, properties, profiles] = await Promise.all([
    supabaseGet("/rest/v1/tenants", {
      select: "id,name,slug,license_tier,max_property_licenses,status,parent_organization_id,created_at",
      order: "created_at.desc",
    }),
    supabaseGet("/rest/v1/properties", { select: "id,tenant_id" }),
    supabaseGet("/rest/v1/profiles", { select: "id,tenant_id,full_name,status", order: "full_name.asc" }),
  ]);

  const propertyCounts = new Map();
  for (const property of properties) {
    if (!property.tenant_id) continue;
    propertyCounts.set(property.tenant_id, (propertyCounts.get(property.tenant_id) || 0) + 1);
  }

  const staffCounts = new Map();
  const staffNames = new Map();
  for (const profile of profiles) {
    if (!profile.tenant_id) continue;
    staffCounts.set(profile.tenant_id, (staffCounts.get(profile.tenant_id) || 0) + 1);
    if (profile.status === "inactive") continue;
    const names = staffNames.get(profile.tenant_id) || [];
    if (profile.full_name) names.push(profile.full_name);
    staffNames.set(profile.tenant_id, names);
  }

  const namesById = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  const items = tenants.map((tenant) =>
    toTenant(
      tenant,
      propertyCounts.get(tenant.id) || 0,
      staffCounts.get(tenant.id) || 0,
      staffNames.get(tenant.id) || [],
      tenant.parent_organization_id ? namesById.get(tenant.parent_organization_id) || null : null
    )
  );

  return {
    cards: {
      subscribedTenants: items.length,
      activePropertySkus: items.reduce((sum, tenant) => sum + tenant.propertyCount, 0),
      totalLicensedCapacity: items.reduce((sum, tenant) => sum + (tenant.propertyLimit || 0), 0),
    },
    tenants: items,
  };
}

function toStaff(profile) {
  return {
    id: profile.id,
    fullName: profile.full_name,
    email: profile.email,
    role: profile.role,
    status: profile.status,
    humanId: profile.human_id,
  };
}

function toProperty(property) {
  return {
    id: property.id,
    name: property.name,
    humanId: property.human_id,
    city: property.city,
    state: property.state,
    isActive: property.is_active,
  };
}

async function getById(id) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Tenant not found");

  assertConfigured();

  const tenants = await supabaseGet("/rest/v1/tenants", {
    id: `eq.${parsed.data}`,
    select: "id,name,slug,license_tier,max_property_licenses,status,parent_organization_id,created_at",
  });
  const tenant = tenants[0];
  if (!tenant) throw new HttpError(404, "Tenant not found");

  const [properties, profiles, parents] = await Promise.all([
    supabaseGet("/rest/v1/properties", {
      tenant_id: `eq.${tenant.id}`,
      select: "id,name,human_id,city,state,is_active",
      order: "name.asc",
    }),
    supabaseGet("/rest/v1/profiles", {
      tenant_id: `eq.${tenant.id}`,
      select: "id,full_name,email,role,status,human_id",
      order: "full_name.asc",
    }),
    tenant.parent_organization_id
      ? supabaseGet("/rest/v1/tenants", {
          id: `eq.${tenant.parent_organization_id}`,
          select: "id,name",
        })
      : Promise.resolve([]),
  ]);

  const staffNames = profiles
    .filter((profile) => profile.status !== "inactive" && profile.full_name)
    .map((profile) => profile.full_name);

  return {
    tenant: {
      ...toTenant(
        tenant,
        properties.length,
        profiles.length,
        staffNames,
        parents[0] ? parents[0].name : null
      ),
      staff: profiles.map(toStaff),
      properties: properties.map(toProperty),
    },
  };
}

module.exports = { list, getById };
