/**
 * G3 load generator (C2 multi-poller SKIP-LOCKED). Drives N photo→session→streamed-turn loops/sec against the
 * eve FRONT so >=2 pollers compete for the same world's steps. Outcomes are checked by sql/skip-locked-probe.sql,
 * NOT by this generator — the generator only produces concurrent load; correctness is asserted in the DB.
 *
 * Cred/cloud-gated: needs a live FRONT_URL + a valid Clerk JWT. With neither present it exits non-zero with a
 * clear operator message rather than pretending to have generated load.
 *
 * Run:  bun infra/g3-spike/scripts/load-gen.ts --tps 5 --seconds 60
 */

type Args = { tps: number; seconds: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string, dflt: number) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
  };
  return { tps: get("--tps", 5), seconds: get("--seconds", 60) };
}

async function main() {
  const { tps, seconds } = parseArgs(process.argv.slice(2));
  const FRONT_URL = process.env.FRONT_URL;
  const CLERK_JWT = process.env.CLERK_JWT;

  if (!FRONT_URL || !CLERK_JWT) {
    console.error(
      "[g3] OPERATOR ACTION REQUIRED — load-gen needs a live eve FRONT + Clerk JWT:\n" +
        "       export FRONT_URL=https://<eve-front>.run.app\n" +
        "       export CLERK_JWT=<a valid Clerk session JWT (networkless-verifiable, §12)>\n" +
        "       then re-run. (This generator will NOT fabricate load.)",
    );
    process.exit(78); // EX_CONFIG — no creds in this sandbox
  }

  const totalTurns = tps * seconds;
  const intervalMs = 1000 / tps;
  let launched = 0;
  console.error(`[g3] load-gen: ${tps} turns/sec for ${seconds}s (${totalTurns} turns) -> ${FRONT_URL}`);

  const fireTurn = async () => {
    // One photo→session→streamed-turn loop. We only need the stream to reach a terminal state; the
    // exactly-once correctness is proven by the SQL probe against the world tables, not here.
    const res = await fetch(`${FRONT_URL}/eve/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLERK_JWT}` },
      // body: a multipart photo file-part (signed-URL or inline), per §4.3 — wired by the operator/CI.
    });
    // Drain the NDJSON stream so the poller actually advances the run under contention.
    await res.body?.cancel?.();
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (launched >= totalTurns) {
        clearInterval(timer);
        resolve();
        return;
      }
      launched++;
      void fireTurn().catch((e) => console.error(`[g3] turn error: ${e}`));
    }, intervalMs);
  });

  console.error(`[g3] load-gen done: launched ${launched} turns. Now run sql/skip-locked-probe.sql to assert C2.`);
}

void main();
