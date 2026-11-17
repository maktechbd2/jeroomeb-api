const express = require("express");
const { asyncHandler } = require("../../shared/http");
const { requireAuth, requireRole } = require("../../shared/auth");
const reportController = require("./reports.controller");

const router = express.Router();
const staff = [requireAuth, requireRole("SUPER_ADMIN", "TEAM_MEMBER", "SPECIALIST")];
const superAdmin = [requireAuth, requireRole("SUPER_ADMIN")];

router.get("/", ...staff, asyncHandler(reportController.list));
router.post("/:id/resend", ...superAdmin, asyncHandler(reportController.resend));
router.delete("/:id", ...superAdmin, asyncHandler(reportController.remove));
router.get("/:id", ...staff, asyncHandler(reportController.show));

module.exports = router;
