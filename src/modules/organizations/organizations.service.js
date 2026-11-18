const bcrypt = require("bcryptjs");
const prisma = require("../../shared/prisma");
const { HttpError } = require("../../shared/http");
const { isUniqueConflict } = require("../../shared/codes");
const { sendTenantWelcomeEmail } = require("../../shared/mailer");

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function money(value) {
  return value == null ? null : value.toString();
}

function toPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    monthlyPrice: money(plan.monthlyPrice),
    propertyLimit: plan.propertyLimit,
  };
}

const statusLabels = {
  UNPAID: "Pending",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  const letters = (words[0] || "T").replace(/[^a-zA-Z0-9]/g, "");
  return (letters.slice(0, 2) || "T").toUpperCase();
}

function slugify(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "tenant";
}

function licenseTier(organization) {
  if (organization.licensePlan) return organization.licensePlan.name;
  if (organization.servicePriceBand) return organization.servicePriceBand.name;
  return null;
}

function pickAdmin(users) {
  const people = users || [];
  const admin = people.find((user) => user.role === "TENANT_ADMIN") || people[0];
  if (!admin) return null;
  return {
    id: admin.id,
    fullName: admin.fullName,
    email: admin.email,
    joinedAt: admin.createdAt,
  };
}

function toTenant(organization) {
  const properties = organization.properties || [];
  const countedProperties = organization._count ? organization._count.properties : undefined;
  const propertyCount = organization.properties ? properties.length : countedProperties;
  const activePropertyCount = organization.properties
    ? properties.filter((property) => property.status === "ACTIVE").length
    : undefined;
  const staffCount = organization._count ? organization._count.users : undefined;
  return {
    id: organization.id,
    name: organization.name,
    initials: initials(organization.name),
    slug: slugify(organization.name),
    subscriptionStatus: organization.subscriptionStatus,
    statusLabel: statusLabels[organization.subscriptionStatus] || organization.subscriptionStatus,
    propertyLimit: organization.propertyLimit,
    licensePlan: toPlan(organization.licensePlan),
    licenseTier: licenseTier(organization),
    planKind: organization.planKind,
    paidAt: organization.paidAt,
    priceBand: organization.servicePriceBand
      ? {
          id: organization.servicePriceBand.id,
          name: organization.servicePriceBand.name,
          kind: organization.servicePriceBand.kind,
          monthlyPrice: money(organization.servicePriceBand.monthlyPrice),
        }
      : null,
    admin: pickAdmin(organization.users),
    userCount: staffCount,
    staffCount,
    propertyCount,
    activePropertyCount,
    createdAt: organization.createdAt,
  };
}

const listInclude = {
  licensePlan: true,
  servicePriceBand: true,
  properties: { select: { status: true } },
  users: {
    where: { role: "TENANT_ADMIN", status: { not: "DISABLED" } },
    select: { id: true, email: true, fullName: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 1,
  },
  _count: {
    select: {
      users: { where: { status: { not: "DISABLED" } } },
    },
  },
};

const tenantInclude = {
  licensePlan: true,
  servicePriceBand: true,
  properties: { select: { id: true, status: true } },
  users: {
    where: { status: { not: "DISABLED" } },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  },
  _count: {
    select: {
      users: { where: { status: { not: "DISABLED" } } },
    },
  },
};

function listStatus(value) {
  if (!value) return null;
  const raw = value.trim().toUpperCase();
  if (!raw || raw === "ALL") return null;
  const status = raw === "PENDING" ? "UNPAID" : raw;
  if (!Object.prototype.hasOwnProperty.call(statusLabels, status)) {
    throw new HttpError(400, "Unknown status");
  }
  return status;
}

function matchesSearch(tenant, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [tenant.name, tenant.slug, tenant.id, tenant.admin && tenant.admin.fullName, tenant.admin && tenant.admin.email];
  return fields.some((field) => field && String(field).toLowerCase().includes(needle));
}

async function list(query = {}) {
  const organizations = await prisma.organization.findMany({
    include: listInclude,
    orderBy: { createdAt: "desc" },
  });
  const missingAdmin = organizations.filter((organization) => organization.users.length === 0);
  if (missingAdmin.length) {
    const fallbacks = await prisma.user.findMany({
      where: {
        organizationId: { in: missingAdmin.map((organization) => organization.id) },
        status: { not: "DISABLED" },
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        createdAt: true,
        organizationId: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const firstByOrg = new Map();
    for (const user of fallbacks) {
      if (!firstByOrg.has(user.organizationId)) firstByOrg.set(user.organizationId, user);
    }
    for (const organization of missingAdmin) {
      const user = firstByOrg.get(organization.id);
      if (user) organization.users = [user];
    }
  }
  const tenants = organizations.map(toTenant);
  const status = listStatus(query.status);
  const q = query.q ? query.q.trim() : "";
  return {
    cards: {
      subscribedTenants: tenants.filter((tenant) => tenant.subscriptionStatus === "ACTIVE").length,
      totalAccounts: tenants.length,
      activePropertySkus: tenants.reduce((sum, tenant) => sum + (tenant.activePropertyCount || 0), 0),
      totalLicensedCapacity: organizations.reduce(
        (sum, organization) => sum + (organization.propertyLimit || 0),
        0
      ),
    },
    tenants: tenants.filter((tenant) => {
      if (status && tenant.subscriptionStatus !== status) return false;
      return matchesSearch(tenant, q);
    }),
  };
}

async function getById(id) {
  const organization = await prisma.organization.findUnique({
    where: { id },
    include: {
      ...tenantInclude,
      users: {
        select: {
          id: true,
          email: true,
          fullName: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      properties: {
        select: { id: true, code: true, name: true, status: true, propertyType: true },
        orderBy: { createdAt: "desc" },
      },
      checklistAccess: {
        include: { template: { select: { id: true, name: true } } },
      },
    },
  });
  if (!organization) throw new HttpError(404, "Tenant not found");

  return {
    tenant: {
      ...toTenant(organization),
      users: organization.users,
      properties: organization.properties,
      checklists: organization.checklistAccess.map((link) => link.template),
    },
  };
}

async function provision(input, actor) {
  const email = normalizeEmail(input.admin.email);
  const band = await prisma.servicePriceBand.findFirst({
    where: { id: input.priceBandId, active: true, kind: "SOFTWARE" },
  });
  if (!band) throw new HttpError(400, "Software plan not found");

  const templateIds = [...new Set(input.checklistTemplateIds)];
  if (templateIds.length) {
    const templates = await prisma.checklistTemplate.findMany({
      where: { id: { in: templateIds }, active: true },
    });
    if (templates.length !== templateIds.length) {
      throw new HttpError(400, "One or more checklist templates are not available");
    }
  }

  const passwordHash = await bcrypt.hash(input.admin.password, 12);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: input.name,
          planKind: "SOFTWARE",
          servicePriceBandId: band.id,
          propertyLimit: input.propertyLimit ?? null,
          subscriptionStatus: input.subscriptionStatus,
          checklistAccess: {
            create: templateIds.map((templateId) => ({ templateId })),
          },
        },
        include: tenantInclude,
      });

      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: input.admin.fullName,
          phone: input.admin.phone || null,
          role: "TENANT_ADMIN",
          status: "ACTIVE",
          mustChangePassword: true,
          organizationId: organization.id,
        },
      });

      await tx.activityEvent.create({
        data: {
          actorId: actor ? actor.id : null,
          type: "TENANT_PROVISIONED",
          summary: `Provisioned tenant ${organization.name}`,
          entityType: "Organization",
          entityId: organization.id,
        },
      });

      return { organization, user };
    });

    const saved = await prisma.organization.findUnique({
      where: { id: result.organization.id },
      include: tenantInclude,
    });

    try {
      await sendTenantWelcomeEmail({
        to: email,
        fullName: input.admin.fullName,
        organizationName: result.organization.name,
        password: input.admin.password,
      });
    } catch (error) {
      console.error("Tenant welcome email failed:", error.message);
      throw new HttpError(502, "The tenant was created, but the welcome email could not be sent");
    }

    return {
      tenant: toTenant(saved),
      user: {
        id: result.user.id,
        email: result.user.email,
        fullName: result.user.fullName,
        role: result.user.role,
        status: result.user.status,
        mustChangePassword: result.user.mustChangePassword,
      },
    };
  } catch (error) {
    if (isUniqueConflict(error, "email")) {
      throw new HttpError(409, "An account with this email already exists");
    }
    throw error;
  }
}

module.exports = { list, getById, provision };
