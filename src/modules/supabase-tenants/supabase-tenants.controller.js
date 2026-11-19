const tenantService = require("./supabase-tenants.service");

async function list(req, res) {
  res.json(await tenantService.list());
}

async function show(req, res) {
  res.json(await tenantService.getById(req.params.id));
}

module.exports = { list, show };
