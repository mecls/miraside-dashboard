/** @type {import('next').NextConfig} */
const nextConfig = {
  // Creative thumbnails render via a plain <img> (short-lived signed fbcdn URLs),
  // so next/image remote config is intentionally not used.

  // The brand marks are read from /public at runtime (components/Brand.tsx, fs.readFileSync).
  // Force them into the serverless function bundle so the logo renders on Vercel — the
  // file tracer won't pick up a dynamic readFileSync path on its own.
  // (Top-level in Next 15+; was under `experimental` in Next 14.)
  outputFileTracingIncludes: {
    "/**": ["./public/**/*"],
  },
};

export default nextConfig;
