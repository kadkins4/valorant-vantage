import "dotenv/config";
import { db } from "@/lib/db/client";
import {
  matches,
  rankHistory,
  syncRuns,
  type MatchRow,
  type RankRow,
} from "@/lib/db/schema";
import { henrik, HenrikError } from "@/lib/henrik";
import { account } from "@/lib/config";
import {
  storedMatchToRow,
  mmrEntryToRankRow,
  normalizeDetail,
} from "@/lib/transform";
import { writeSnapshot } from "@/lib/snapshot";
import { sql } from "drizzle-orm";

async function main() {
  const { name, tag, region, platform } = account;
  const acc = await henrik.account(name, tag);
  const puuid = acc.data.puuid;
  const mmr = await henrik.mmr(region, platform, name, tag);
  const hist = await henrik.mmrHistory(region, platform, name, tag);
  const stored = await henrik.storedCompetitive(region, name, tag);

  const matchRows: MatchRow[] = stored.data.map(storedMatchToRow);
  const rankRows: RankRow[] = (hist.data.history ?? []).map(mmrEntryToRankRow);

  // Count new rows by diffing existing ids (robust across drivers).
  const existingMatchIds = new Set(
    (await db.select({ id: matches.matchId }).from(matches)).map((r) => r.id),
  );
  const existingRankIds = new Set(
    (await db.select({ id: rankHistory.matchId }).from(rankHistory)).map(
      (r) => r.id,
    ),
  );
  const newMatches = matchRows.filter((r) => !existingMatchIds.has(r.matchId));
  const newRanks = rankRows.filter((r) => !existingRankIds.has(r.matchId));

  if (newMatches.length)
    await db.insert(matches).values(newMatches).onConflictDoNothing();
  if (newRanks.length)
    await db.insert(rankHistory).values(newRanks).onConflictDoNothing();

  const matchesAdded = newMatches.length;
  const ranksAdded = newRanks.length;

  // Deep-detail any NEW matches missing detail (throttled inside henrik client).
  const need = await db
    .select({ id: matches.matchId })
    .from(matches)
    .where(sql`${matches.hasDetail} = false`);
  let detailAdded = 0;
  for (const { id } of need) {
    try {
      const full = await henrik.matchById(region, id);
      const detail = normalizeDetail(full.data, puuid);
      await db
        .update(matches)
        .set({ detail, hasDetail: true })
        .where(sql`${matches.matchId} = ${id}`);
      detailAdded++;
    } catch (e) {
      console.warn(`detail fetch failed for ${id}:`, (e as Error).message);
    }
  }

  await db.insert(syncRuns).values({
    matchesAdded,
    ranksAdded,
    ok: true,
    note: `synced ${matchRows.length} matches, ${rankRows.length} rank pts`,
  });

  // Only rewrite the snapshot when the DB actually changed. The snapshot carries
  // a fresh generatedAt (and Henrik's account payload a fresh updated_at) on every
  // run, so writing it unconditionally produced a no-op diff every hour — the sync
  // bot would commit and redeploy even when nothing was played. Gating on real
  // changes makes generatedAt mean "last new data" and stops the churn.
  const changed = matchesAdded > 0 || ranksAdded > 0 || detailAdded > 0;
  if (changed) {
    const allMatches = await db.select().from(matches);
    const allRanks = await db.select().from(rankHistory);
    writeSnapshot({
      generatedAt: new Date().toISOString(),
      account: acc.data,
      mmr: mmr.data,
      matches: allMatches,
      rankHistory: allRanks,
    });
  }

  console.log(
    `Sync OK: +${matchesAdded} matches, +${ranksAdded} rank pts, +${detailAdded} details.` +
      (changed ? " Snapshot written." : " No new data; snapshot unchanged."),
  );
  process.exit(0);
}
main().catch(async (e) => {
  // Upstream HenrikDev outages (5xx/429 after retries, or network failure) are
  // transient and out of our hands. During a multi-hour outage the hourly cron
  // would otherwise email a hard failure every run. Soft-fail instead: record
  // the failed run and exit 0 so no alert fires. The next good run catches up.
  // Anything else (DB down, bad data, our bug) still exits 1 and alerts.
  if (e instanceof HenrikError && e.upstream) {
    console.warn(`Sync skipped — HenrikDev upstream unavailable: ${e.message}`);
    try {
      await db.insert(syncRuns).values({
        matchesAdded: 0,
        ranksAdded: 0,
        ok: false,
        note: `upstream unavailable: ${e.message}`,
      });
    } catch (dbErr) {
      // Couldn't even record the run — that's a real failure, so alert.
      console.error("Failed to record syncRun after upstream error:", dbErr);
      process.exit(1);
    }
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
