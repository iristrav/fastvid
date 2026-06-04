import type { ReactNode } from "react";
import { LegalPageShell } from "@/components/LegalPageShell";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyPolicy() {
  return (
    <LegalPageShell title="Privacy Policy" lastUpdated="June 4, 2026">
      <p>
        This Privacy Policy describes how Fastvid (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects,
        uses, and protects information when you use our website and video generation service (the
        &quot;Service&quot;), available at our production application and related pages.
      </p>

      <Section title="1. Who we are">
        <p>
          Fastvid is an AI-assisted documentary video generator. Users provide a topic or prompt;
          we generate scripts, voiceovers, and visual montages for personal or commercial use
          according to their subscription plan.
        </p>
      </Section>

      <Section title="2. Information we collect">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-slate-200">Account data:</strong> email address, name (if
            provided), authentication credentials or OAuth identifiers, and subscription status.
          </li>
          <li>
            <strong className="text-slate-200">Content you submit:</strong> video prompts, script
            preferences, generated scripts, scene metadata, and exported video files associated
            with your account.
          </li>
          <li>
            <strong className="text-slate-200">Usage data:</strong> logs of generation jobs,
            progress, errors, and basic technical data (IP address, browser type, timestamps) for
            security and operations.
          </li>
          <li>
            <strong className="text-slate-200">Payment data:</strong> processed by our payment
            provider (e.g. Stripe). We do not store full card numbers on our servers.
          </li>
        </ul>
      </Section>

      <Section title="3. How we use your information">
        <ul className="list-disc pl-5 space-y-2">
          <li>Provide, maintain, and improve the Service.</li>
          <li>Authenticate users and manage subscriptions.</li>
          <li>Generate videos, including calling third-party APIs described below.</li>
          <li>Respond to support requests and comply with legal obligations.</li>
          <li>Prevent abuse, fraud, and unauthorized access.</li>
        </ul>
      </Section>

      <Section title="4. Third-party services and YouTube API">
        <p className="mb-3">
          To produce videos we may send limited data to trusted processors. These providers process
          data under their own terms and privacy policies:
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-slate-200">YouTube Data API v3:</strong> We use the API only to
            search for videos licensed under Creative Commons, matching script topics (e.g. public
            figures or events). We do not offer a public YouTube downloader. Search queries and
            returned metadata (titles, video IDs) are used solely to select clips for your project.
            Use of YouTube services is subject to the{" "}
            <a
              href="https://www.youtube.com/t/terms"
              className="text-cyan-400 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              YouTube Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="https://policies.google.com/privacy"
              className="text-cyan-400 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong className="text-slate-200">Stock and media APIs:</strong> e.g. Pexels, Pixabay,
            SerpAPI, and licensed download services for Creative Commons YouTube clips, to fetch
            imagery or footage aligned with your script.
          </li>
          <li>
            <strong className="text-slate-200">AI and voice:</strong> language models and text-to-speech
            providers to write narration and synthesize voiceovers.
          </li>
          <li>
            <strong className="text-slate-200">Hosting:</strong> cloud infrastructure (e.g. Railway)
            for application hosting and file storage on persistent volumes where configured.
          </li>
        </ul>
        <p className="mt-3">
          We do not sell your personal information. We share data with processors only as needed to
          operate the Service.
        </p>
      </Section>

      <Section title="5. Retention and storage">
        <p>
          Generated videos and project data are stored for your account until you delete them or
          close your account, subject to backup and legal retention requirements. Temporary
          processing files may be removed automatically after a video is completed.
        </p>
      </Section>

      <Section title="6. Cookies and authentication">
        <p>
          We use essential cookies or similar technologies for login sessions and security. Optional
          analytics cookies, if enabled in the future, will be described in an updated policy or
          cookie notice.
        </p>
      </Section>

      <Section title="7. Your rights">
        <p>
          Depending on your location (including the EEA/UK), you may have rights to access, correct,
          delete, or restrict processing of your personal data, and to data portability or objection.
          To exercise these rights, contact us using the details below. You may also lodge a complaint
          with your local data protection authority.
        </p>
      </Section>

      <Section title="8. Security">
        <p>
          We use industry-standard measures such as HTTPS, access controls, and secure credential
          storage for API keys on our servers. No method of transmission over the Internet is 100%
          secure; we cannot guarantee absolute security.
        </p>
      </Section>

      <Section title="9. Children">
        <p>
          The Service is not directed at children under 16. We do not knowingly collect personal
          information from children. Contact us if you believe a child has provided data to us.
        </p>
      </Section>

      <Section title="10. Changes">
        <p>
          We may update this Privacy Policy from time to time. We will post the new version on this
          page with an updated &quot;Last updated&quot; date. Continued use of the Service after changes
          constitutes acceptance of the revised policy.
        </p>
      </Section>

      <Section title="11. Contact">
        <p>
          For privacy questions or requests, contact us at:{" "}
          <a href="mailto:privacy@fastvid.app" className="text-cyan-400 hover:underline">
            privacy@fastvid.app
          </a>
          . You may also reach us through the contact options on our homepage.
        </p>
      </Section>
    </LegalPageShell>
  );
}
