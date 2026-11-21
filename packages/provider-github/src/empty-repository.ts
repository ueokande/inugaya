import { FatalError } from "@inugaya/sdk";
import { z } from "zod";
import { ApiError, type GitHubClient } from "./client.js";

const branchesSchema = z.array(z.object({ name: z.string().min(1) }));

export async function isEmptyRepository(
  api: GitHubClient,
  base: string,
  lookupError: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(lookupError instanceof ApiError)) return false;
  if (lookupError.code === "EMPTY_REPOSITORY") return true;
  if (lookupError.status !== 404) return false;

  // A 404 alone cannot distinguish an empty repository from denied access.
  try {
    const branches = branchesSchema.parse(
      await api.get(`${base}/branches?per_page=1`, signal),
    );
    return branches.length === 0;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof FatalError) throw error;
    if (!(error instanceof ApiError)) return false;
    if (error.code === "EMPTY_REPOSITORY") return true;
    if (error.status !== 404) return false;
  }

  // The branch list may also return 404. The commit list can explicitly
  // confirm an empty Git repository without resolving a branch name.
  try {
    await api.get(`${base}/commits?per_page=1`, signal);
    return false;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof FatalError) throw error;
    return error instanceof ApiError && error.code === "EMPTY_REPOSITORY";
  }
}
