import { LegalPageShell, LegalSection } from "@/components/LegalPageShell";

export default function TermsOfService() {
  return (
    <LegalPageShell title="Terms of Service" lastUpdated="June 9, 2026">
      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and use of the Fastvid website
        and video generation platform (the &quot;Service&quot;). By creating an account or using the Service,
        you agree to these Terms. If you do not agree, do not use the Service.
      </p>

      <LegalSection title="1. The Service">
        <p>
          Fastvid provides AI-assisted tools to generate documentary-style videos, including scripts,
          voiceovers, and visual montages from user prompts. Output quality and availability depend on
          third-party APIs, your subscription plan, and technical limits described in the product.
        </p>
      </LegalSection>

      <LegalSection title="2. Eligibility and accounts">
        <ul className="list-disc pl-5 space-y-2">
          <li>You must be at least 16 years old (or the age required in your country) to use the Service.</li>
          <li>You are responsible for keeping your login credentials secure and for activity under your account.</li>
          <li>You must provide accurate registration information and notify us of unauthorized access.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Subscriptions and payments">
        <p>
          Paid features require an active subscription or credits as shown at checkout. Prices, billing
          intervals, and renewal terms are displayed before purchase. Payments are processed by our
          payment provider; refunds are handled according to the plan shown at purchase and applicable law.
          We may change pricing with reasonable notice for future billing periods.
        </p>
      </LegalSection>

      <LegalSection title="4. Your content and responsibilities">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            You retain rights to prompts and original material you submit. You grant us a license to
            process that content solely to operate the Service (generate scripts, audio, and videos).
          </li>
          <li>
            You are responsible for ensuring your prompts and use of exported videos comply with applicable
            law, platform rules (e.g. YouTube, TikTok, Instagram), and third-party licenses.
          </li>
          <li>
            You must not use the Service to create or distribute illegal, harassing, defamatory, or
            infringing content, or content that violates others&apos; privacy or intellectual property rights.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Media archive and third-party content">
        <p className="mb-3">
          Visuals are sourced exclusively from curated media archives that you or your administrator upload
          and tag in the Service. We do not fetch stock footage, web images, or AI-generated clips for
          beat visuals unless a different sourcing mode is explicitly enabled for your deployment. All
          archive materials remain subject to their respective licenses. You are responsible for verifying
          that your use of exported videos complies with those licenses and with the rules of any platform
          where you publish (including YouTube, TikTok, and Instagram).
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            We do not guarantee that any specific clip, topic, or visual will be available, unique, or
            cleared for your intended use without additional review or rights clearance on your part.
          </li>
          <li>
            Where YouTube or other API integrations are used, those services are subject to their own terms
            (including the{" "}
            <a
              href="https://developers.google.com/youtube/terms/api-services-terms-of-service"
              className="text-cyan-400 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              YouTube API Services Terms of Service
            </a>
            ).
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="6. YouTube, copyright claims, and platform strikes">
        <p className="mb-3">
          <strong className="text-white">
            Fastvid is not responsible for copyright claims, Content ID matches, takedown notices, community
            guideline strikes, copyright strikes, demonetization, or other penalties imposed by YouTube or
            any other platform
          </strong>{" "}
          in connection with videos you create, edit, or publish using the Service.
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            You are solely responsible for reviewing all generated scripts, voiceovers, and visuals before
            publication, and for ensuring you have the rights and permissions required for your use.
          </li>
          <li>
            Fastvid provides tools only; we do not upload, publish, or monetize content on your behalf on
            YouTube or elsewhere.
          </li>
          <li>
            AI-generated or archive-sourced material may resemble existing works or include material subject
            to third-party rights. We do not warrant that outputs are free from infringement or suitable for
            commercial or monetized use without your own legal review.
          </li>
          <li>
            Any dispute, claim, or strike arising from content you publish is between you and the relevant
            platform or rights holder. You agree to handle such matters at your own expense.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="7. Indemnification">
        <p>
          To the maximum extent permitted by law, you agree to indemnify, defend, and hold harmless Fastvid,
          its operators, affiliates, and suppliers from any claims, damages, losses, liabilities, costs, and
          expenses (including reasonable legal fees) arising from or related to: (a) your use of the Service;
          (b) content you create, export, or publish; (c) alleged infringement or violation of third-party
          rights; or (d) your breach of these Terms or applicable platform rules.
        </p>
      </LegalSection>

      <LegalSection title="8. Intellectual property">
        <p>
          The Service, including software, branding, and documentation, is owned by Fastvid or its
          licensors. Except for rights expressly granted here, no rights are transferred to you. Generated
          outputs are provided for your use according to your plan; underlying third-party media may
          impose additional attribution or usage requirements.
        </p>
      </LegalSection>

      <LegalSection title="9. Disclaimers">
        <p>
          The Service and generated content are provided &quot;as is&quot; and &quot;as available&quot; without warranties of
          any kind, whether express or implied, including merchantability, fitness for a particular purpose,
          and non-infringement. We do not warrant that outputs will be error-free, unique, factually accurate,
          or suitable for any particular commercial purpose without your own review.
        </p>
      </LegalSection>

      <LegalSection title="10. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Fastvid and its affiliates will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for loss of profits, data,
          goodwill, channel standing, monetization, or platform access (including YouTube strikes or
          copyright claims), arising from your use of the Service. Our total liability for claims relating to the
          Service in any twelve-month period is limited to the amount you paid us for the Service in that
          period, or one hundred dollars ($100), whichever is greater, unless mandatory law requires otherwise.
        </p>
      </LegalSection>

      <LegalSection title="11. Suspension and termination">
        <p>
          We may suspend or terminate access if you breach these Terms, abuse the Service, or if required
          by law. You may stop using the Service at any time. Provisions that by nature should survive
          termination (including intellectual property, disclaimers, and liability limits) will survive.
        </p>
      </LegalSection>

      <LegalSection title="12. Changes">
        <p>
          We may update these Terms from time to time. The &quot;Last updated&quot; date at the top of this page
          will change when we do. Continued use after changes constitutes acceptance of the revised Terms.
        </p>
      </LegalSection>

      <LegalSection title="13. Governing law">
        <p>
          These Terms are governed by the laws of the Netherlands, without regard to conflict-of-law rules,
          unless mandatory consumer protection laws in your country require otherwise. Disputes shall be
          submitted to the competent courts in the Netherlands, unless applicable law grants you the right
          to bring claims in your country of residence.
        </p>
      </LegalSection>

      <LegalSection title="14. Contact">
        <p>
          Questions about these Terms:{" "}
          <a href="mailto:legal@fastvid.app" className="text-cyan-400 hover:underline">
            legal@fastvid.app
          </a>
          . See our{" "}
          <a href="/privacy" className="text-cyan-400 hover:underline">
            Privacy Policy
          </a>{" "}
          for how we handle personal data.
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
