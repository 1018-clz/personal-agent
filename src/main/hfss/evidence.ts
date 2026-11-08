import type { EvidenceGrade, EvidenceJob, EvidenceView, HfssJob } from "../../shared/types";

/**
 * The evidence gate: after a reply that used simulation results, check where its numbers came from.
 *
 * It does not block or rewrite anything. It tells the user what the reply rests on: which jobs, at
 * what mesh level, converged or not, and which RF numbers appear in no result of the turn (made up,
 * or worked out by the model). The system prompt asks the model for the same; this checks it did.
 */

export const JOB_ID = /\bj\d{8}-\d{6}-[0-9a-f]{4}\b/g;
/** A number with a frequency or decibel unit, e.g. "7.86 GHz", "−18.2 dB", "14.6MHz". */
const RF_NUMBER = /([-−+]?\d+(?:\.\d+)?)\s*(GHz|MHz|kHz|dBi|dB)\b/g;
const ANY_NUMBER = /[-−]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
/** Words that tell the reader a result only shows a trend. */
const CAVEAT = /趋势|粗网格|coarse|未收敛|不收敛|不可信|仅供参考|不能写进|不能用来|只能看/i;
/** Saying a simulation was submitted or queued, in the past tense: "已提交", "另外提交了", "排上队了". */
const SUBMIT_CLAIM = /提交了|已提交|已经提交|排上队|排进(了)?队列|已在后台|放进(了)?队列|submitted/i;
/** Differences are worked out, not looked up: at most this many source numbers are paired. */
const MAX_PAIRED = 300;

export interface RfNumber {
  text: string;
  value: number;
  unit: "GHz" | "MHz" | "kHz" | "dB" | "dBi";
}

export function rfNumbers(text: string): RfNumber[] {
  return [...text.matchAll(RF_NUMBER)].map((match) => ({
    text: match[0].trim(),
    value: Number((match[1] ?? "").replace("−", "-")),
    unit: match[2] as RfNumber["unit"],
  }));
}

export function allNumbers(text: string): number[] {
  return [...text.matchAll(ANY_NUMBER)].map((match) => Number(match[0].replace("−", "-"))).filter(Number.isFinite);
}

function decimals(text: string): number {
  const match = /\.(\d+)/.exec(text);
  return match?.[1]?.length ?? 0;
}

/** Same number as written to that precision, or within 0.2 %: "7.86 GHz" matches 7862.5 MHz. */
function close(written: number, places: number, candidate: number): boolean {
  const step = 10 ** -places;
  return Math.abs(written - candidate) <= step / 2 + 1e-9 || Math.abs(written - candidate) <= Math.abs(candidate) * 0.002;
}

/** The values a reply's number may stand for, in the units the sources might use. */
function readings(number: RfNumber): Array<{ value: number; places: number }> {
  const places = decimals(number.text);
  if (number.unit === "dB" || number.unit === "dBi") {
    // "insertion loss 0.56 dB" is -0.56 dB of S21, and "rejection 2.5 dB" may be stored as -2.5.
    return [
      { value: number.value, places },
      { value: -number.value, places },
    ];
  }
  const ghz = number.value * { GHz: 1, MHz: 1e-3, kHz: 1e-6 }[number.unit];
  // Sources hold frequencies in GHz (f0_ghz) or MHz (f0_mhz, bw3_mhz).
  return [
    { value: ghz, places: places + (number.unit === "GHz" ? 0 : number.unit === "MHz" ? 3 : 6) },
    { value: ghz * 1e3, places: places + (number.unit === "GHz" ? -3 : number.unit === "MHz" ? 0 : 3) },
  ].map((reading) => ({ ...reading, places: Math.max(reading.places, 0) }));
}

export function grade(job: Pick<HfssJob, "state" | "mesh" | "converged">): EvidenceGrade {
  if (job.state !== "done" || job.converged === undefined || job.converged === null) return "unknown";
  if (!job.converged) return "untrusted";
  return job.mesh === "fine" || job.mesh === "verify" ? "final" : "trend";
}

export interface EvidenceInput {
  reply: string;
  /** Whether a submit tool succeeded in the turn: a reply that says it submitted needs one. */
  submitted?: boolean;
  /** What the numbers may come from: tool results, tool arguments and the user's own message. */
  sources: string[];
  /** Jobs whose results the turn read, or that the reply names. */
  jobIds: string[];
  /** The latest known state of jobs, from the task panel's list. */
  known: ReadonlyMap<string, HfssJob>;
}

/** Null when there is nothing to check: no simulated numbers quoted, and no claim of a submission. */
export function checkEvidence({ reply, sources, jobIds, known, submitted = true }: EvidenceInput): EvidenceView | null {
  const unbackedClaim = !submitted && SUBMIT_CLAIM.test(reply);
  const mentioned = [...reply.matchAll(JOB_ID)].map((match) => match[0]);
  const ids = [...new Set([...jobIds, ...mentioned])];
  const quoted = rfNumbers(reply);
  // Job ids alone (a list of what was just queued) rest on nothing yet.
  if (!unbackedClaim && (!ids.length || !quoted.length)) return null;

  const jobs: EvidenceJob[] = ids.map((id) => {
    const job = known.get(id);
    return job
      ? { id, mesh: job.mesh, converged: job.converged ?? null, grade: grade(job) }
      : { id, mesh: "?", converged: null, grade: "unknown" };
  });

  const pool = sources.flatMap(allNumbers);
  // Differences may mix units (7.87 GHz minus 7862.5 MHz): pair small values in MHz as well.
  const paired = [...new Set(pool.flatMap((x) => (Math.abs(x) < 1_000 ? [x, x * 1_000] : [x])))].slice(0, MAX_PAIRED);
  const differences: number[] = [];
  for (let i = 0; i < paired.length; i += 1) {
    for (let j = i + 1; j < paired.length; j += 1) differences.push(Math.abs(paired[i]! - paired[j]!));
  }
  const candidates = [...pool, ...differences];
  const unmatched = rfNumbers(reply)
    .filter((number) => !readings(number).some(({ value, places }) => candidates.some((c) => close(value, places, c))))
    .map((number) => number.text);

  const weak = jobs.some((job) => job.grade === "trend" || job.grade === "untrusted");
  return {
    jobs,
    unmatched: ids.length ? [...new Set(unmatched)] : [],
    missingCaveat: weak && quoted.length > 0 && !CAVEAT.test(reply),
    ...(unbackedClaim ? { unbackedClaim } : {}),
  };
}

/** Job ids in a tool's result, for the tools that read or submit simulations. */
export function jobIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(JOB_ID)].map((match) => match[0]))];
}
