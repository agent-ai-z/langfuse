import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";

import { type NextApiRequest, type NextApiResponse } from "next";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { projectRetentionSchema } from "@/src/features/auth/lib/projectRetentionSchema";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET" && req.method !== "POST") {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/projects`,
    );
    return res.status(405).json({ message: "Method not allowed" });
  }

  // CHECK AUTH
  const authCheck = await new ApiAuthService(
    prisma,
    redis,
  ).verifyAuthHeaderAndReturnScope(req.headers.authorization);
  if (!authCheck.validKey) {
    return res.status(401).json({
      message: authCheck.error,
    });
  }
  // END CHECK AUTH

  if (req.method === "GET") {
    if (
      authCheck.scope.accessLevel !== "project" ||
      !authCheck.scope.projectId
    ) {
      return res.status(403).json({
        message: "Invalid API key. Are you using an organization key?",
      });
    }

    try {
      // Do not apply rate limits as it can break applications on lower tier plans when using auth_check in prod

      const projects = await prisma.project.findMany({
        select: {
          id: true,
          name: true,
          retentionDays: true,
        },
        where: {
          id: authCheck.scope.projectId,
          // deletedAt: null, // here we want to include deleted projects and grey them in the UI.
        },
      });

      return res.status(200).json({
        data: projects.map((project) => ({
          id: project.id,
          name: project.name,
          ...(project.retentionDays // Do not add if null or 0
            ? { retentionDays: project.retentionDays }
            : {}),
        })),
      });
    } catch (error) {
      logger.error(error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    // Check if using an organization API key
    if (
      authCheck.scope.accessLevel !== "organization" ||
      !authCheck.scope.orgId
    ) {
      return res.status(403).json({
        message:
          "Invalid API key. Organization-scoped API key required for this operation.",
      });
    }

    try {
      const { name, retention } = req.body;

      // Validate project name
      try {
        projectNameSchema.parse({ name });
      } catch (error) {
        return res.status(400).json({
          message:
            "Invalid project name. Should be between 3 and 60 characters.",
        });
      }

      // Validate retention days if provided
      if (retention !== undefined) {
        try {
          projectRetentionSchema.parse({ retention });
        } catch (error) {
          return res.status(400).json({
            message: "Invalid retention value. Must be 0 or at least 7 days.",
          });
        }

        // If retention is non-zero, check for data-retention entitlement
        if (retention > 0) {
          const hasDataRetentionEntitlement = hasEntitlementBasedOnPlan({
            entitlement: "data-retention",
            plan: authCheck.scope.plan,
          });

          if (!hasDataRetentionEntitlement) {
            return res.status(403).json({
              message:
                "The data-retention entitlement is required to set a non-zero retention period.",
            });
          }
        }
      }

      // Check if project with this name already exists in the organization
      const existingProject = await prisma.project.findFirst({
        where: {
          name,
          orgId: authCheck.scope.orgId,
        },
      });

      if (existingProject) {
        return res.status(409).json({
          message:
            "A project with this name already exists in your organization",
        });
      }

      // Create the project
      const project = await prisma.project.create({
        data: {
          name,
          orgId: authCheck.scope.orgId,
          retentionDays: retention,
        },
      });

      return res.status(201).json({
        id: project.id,
        name: project.name,
        ...(project.retentionDays // Do not add if null or 0
          ? { retentionDays: project.retentionDays }
          : {}),
      });
    } catch (error) {
      logger.error("Failed to create project", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
}
