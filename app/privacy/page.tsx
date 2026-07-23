export const metadata = { title: "Privacy Policy — Miraside Dashboard" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-neutral-100">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-neutral-400">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-lg font-medium tracking-tight text-neutral-50">Privacy Policy</h1>
      <p className="mt-2 text-sm text-neutral-500">Miraside Dashboard · Last updated 17 June 2026</p>

      <Section title="Overview">
        <p>
          Miraside Dashboard ("the Service") is a private, internal tool used by Miraside AI to view and manage its own
          Meta (Facebook) advertising. This policy explains what data the Service handles and how. The Service is not
          open to the public — access requires an invited login.
        </p>
      </Section>

      <Section title="What we access">
        <p>
          <strong className="text-neutral-300">Advertising data</strong> — via the Meta Marketing API, for the connected
          ad account only: campaigns, ad sets, ads, creatives, and performance metrics (spend, impressions, clicks,
          results, etc.). Used to display reporting and to create or manage ads at the account owner's direction.
        </p>
        <p>
          <strong className="text-neutral-300">Account data</strong> — the email address of each person granted a login,
          used solely to authenticate access to the Service.
        </p>
      </Section>

      <Section title="How it is stored">
        <p>
          Data is stored in a private, access-controlled Supabase (PostgreSQL) database and served through the Service,
          which is protected behind authenticated logins. Access tokens and secrets are kept server-side and are never
          exposed to the browser.
        </p>
      </Section>

      <Section title="Sharing">
        <p>
          We do not sell or share this data with third parties. It passes only through the infrastructure providers
          required to run the Service — Meta (the source of the advertising data), Supabase (database/auth), and Vercel
          (hosting) — each under their own terms.
        </p>
      </Section>

      <Section title="Retention">
        <p>Data is retained while the account is in use and removed on request or when the account is closed.</p>
      </Section>

      <Section title="Contact">
        <p>
          Questions or data requests: <a className="text-accent hover:underline" href="mailto:miguel.v.rolo@gmail.com">miguel.v.rolo@gmail.com</a>.
        </p>
      </Section>

      <Section title="Changes">
        <p>This policy may be updated from time to time; the "last updated" date above reflects the latest version.</p>
      </Section>
    </div>
  );
}
