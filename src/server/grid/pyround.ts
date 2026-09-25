/**
 * Python-compatible rounding and fixed-point formatting.
 *
 * The incentive and alert maths were written against Python's `round()` and
 * `f"{x:.2f}"`, which round exact ties to even. JS's `Math.round` and `toFixed`
 * round ties up. That only matters on exact binary ties (2.5, 0.125, ...), but
 * those do come up in the money maths, so the parity tests would notice.
 *
 * Works on the exact decimal expansion of the double, which `toFixed(100)` gives
 * for every magnitude this code sees.
 */

export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const negative = x < 0 || Object.is(x, -0);
  const exact = Math.abs(x).toFixed(100);
  const [intPart, frac] = exact.split(".");
  const kept = intPart + frac.slice(0, digits);
  const rest = frac.slice(digits);

  let roundUp: boolean;
  if (rest[0] > "5") roundUp = true;
  else if (rest[0] < "5") roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true;
  else roundUp = Number(kept[kept.length - 1]) % 2 === 1; // exact tie: to even

  let digitsStr = kept;
  if (roundUp) {
    // Decimal-string increment, so no precision is lost on large values.
    const arr = digitsStr.split("");
    let i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === "9") {
        arr[i] = "0";
        i--;
      } else {
        arr[i] = String(Number(arr[i]) + 1);
        break;
      }
    }
    digitsStr = (i < 0 ? "1" : "") + arr.join("");
  }

  const cut = digitsStr.length - digits;
  const whole = digitsStr.slice(0, cut).replace(/^0+(?=\d)/, "") || "0";
  const out = digits > 0 ? `${whole}.${digitsStr.slice(cut)}` : whole;
  // Python keeps the sign on negative values that round to zero ("-0.0").
  return negative ? `-${out}` : out;
}

/** Python's `round(x, digits)`. */
export function pyRound(x: number, digits = 0): number {
  return Number(pyFixed(x, digits));
}

/** Python's `f"{x:,.{digits}f}"`: fixed point with thousands separators. */
export function pyGrouped(x: number, digits: number): string {
  const s = pyFixed(x, digits);
  const sign = s.startsWith("-") ? "-" : "";
  const [whole, frac] = s.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (frac !== undefined ? `.${frac}` : "");
}

/** Python's `f"{x:+.{digits}f}"`. */
export function pySigned(x: number, digits: number): string {
  const s = pyFixed(x, digits);
  return s.startsWith("-") ? s : `+${s}`;
}
