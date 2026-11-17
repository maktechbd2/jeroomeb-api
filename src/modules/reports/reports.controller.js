const { z } = require("zod");
const { HttpError } = require("../../shared/http");
const reportService = require("./reports.service");

function reportId(value) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, "Report not found");
  return parsed.data;
}

async function list(req, res) {
  res.json(await reportService.list(req.user));
}

async function show(req, res) {
  res.json(await reportService.getById(reportId(req.params.id), req.user));
}

async function resend(req, res) {
  res.json(await reportService.resend(reportId(req.params.id), req.user));
}

async function remove(req, res) {
  res.json(await reportService.remove(reportId(req.params.id), req.user));
}

module.exports = { list, show, resend, remove };
