import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import { getUserOrganisationId } from "../lib/organisations";
import { listFirmLibrary } from "../lib/firmVisibility";

export const firmLibraryRouter = Router();

// GET /firm-library — the member-facing firm library: firm-visible matters +
// standalone firm-visible reviews in the caller's organisation (name, owner,
// updated, counts), reached through the normal matter/review routes. Org members
// only; an orgless caller gets an empty library (listFirmLibrary handles null).
firmLibraryRouter.get(
    "/",
    requireAuth,
    asyncHandler(async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const orgId = await getUserOrganisationId(db, userId);
        res.json(await listFirmLibrary(db, userId, userEmail ?? null, orgId));
    }),
);
