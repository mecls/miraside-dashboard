export const eur = (n: number | null | undefined, dp = 2) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-IE", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      }).format(n);

export const int = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-IE").format(Math.round(n));

export const pct = (n: number | null | undefined, dp = 1) =>
  n == null ? "—" : `${n.toFixed(dp)}%`;

export const ratio = (n: number | null | undefined, dp = 2) =>
  n == null ? "—" : n.toFixed(dp);
