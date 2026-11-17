const prisma = require("../../shared/prisma");
const { HttpError } = require("../../shared/http");
const { sendInspectionReportEmail } = require("../../shared/mailer");

const reportInclude = {
  inspection: {
    include: {
      property: { select: { id: true, code: true, name: true, email: true, timezone: true } },
      template: { select: { id: true, name: true } },
      specialist: { include: { user: { select: { fullName: true } } } },
    },
  },
};

function toReport(report) {
  return {
    id: report.id,
    inspectionId: report.inspectionId,
    summary: report.summary,
    pdfUrl: report.pdfUrl,
    emailedAt: report.emailedAt,
    propertyId: report.inspection.property.id,
    propertyCode: report.inspection.property.code,
    propertyName: report.inspection.property.name,
    templateName: report.inspection.template.name,
    specialistName: report.inspection.specialist
      ? report.inspection.specialist.user.fullName
      : null,
    completedAt: report.inspection.completedAt,
    createdAt: report.createdAt,
  };
}

function completedLabel(report) {
  const when = report.inspection.completedAt || report.createdAt;
  const timeZone = report.inspection.property.timezone || "America/New_York";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(when);
  } catch {
    return when.toISOString();
  }
}

async function specialistId(actor) {
  if (actor.role !== "SPECIALIST") return null;
  const profile = await prisma.specialistProfile.findUnique({ where: { userId: actor.id } });
  return profile ? profile.id : "00000000-0000-0000-0000-000000000000";
}

async function list(actor) {
  const where = {};
  const ownId = await specialistId(actor);
  if (ownId) where.inspection = { specialistId: ownId };
  const reports = await prisma.report.findMany({
    where,
    include: reportInclude,
    orderBy: { createdAt: "desc" },
  });
  return { reports: reports.map(toReport) };
}

async function getById(id, actor) {
  const report = await prisma.report.findUnique({ where: { id }, include: reportInclude });
  if (!report) throw new HttpError(404, "Report not found");
  const ownId = await specialistId(actor);
  if (ownId && report.inspection.specialistId !== ownId) {
    throw new HttpError(403, "You do not have access to this");
  }
  return { report: toReport(report) };
}

async function findReport(id) {
  const report = await prisma.report.findUnique({ where: { id }, include: reportInclude });
  if (!report) throw new HttpError(404, "Report not found");
  return report;
}

async function resend(id, actor) {
  const report = await findReport(id);
  const email = report.inspection.property.email && report.inspection.property.email.trim();
  if (!email) throw new HttpError(400, "This property has no email");

  try {
    await sendInspectionReportEmail({
      to: email,
      propertyName: report.inspection.property.name,
      propertyCode: report.inspection.property.code,
      templateName: report.inspection.template.name,
      specialistName: report.inspection.specialist
        ? report.inspection.specialist.user.fullName
        : null,
      completedAt: completedLabel(report),
    });
  } catch (error) {
    console.error("Inspection report email failed:", error.message);
    throw new HttpError(502, "Could not send the report email");
  }

  const saved = await prisma.report.update({
    where: { id },
    data: { emailedAt: new Date() },
    include: reportInclude,
  });
  await prisma.activityEvent.create({
    data: {
      actorId: actor.id,
      type: "REPORT_EMAILED",
      summary: `Report emailed for ${report.inspection.property.code}`,
      entityType: "Report",
      entityId: id,
    },
  });
  return { report: toReport(saved) };
}

async function remove(id, actor) {
  const report = await findReport(id);
  await prisma.$transaction([
    prisma.activityEvent.create({
      data: {
        actorId: actor.id,
        type: "REPORT_DELETED",
        summary: `Report deleted for ${report.inspection.property.code}`,
        entityType: "Report",
        entityId: id,
      },
    }),
    prisma.report.delete({ where: { id } }),
  ]);
  return { message: "Report deleted" };
}

module.exports = { list, getById, resend, remove };
