import { LegalPageShell, LegalSection } from "@/components/LegalPageShell";

export default function TermsOfService() {
  return (
    <LegalPageShell title="Terms of Service" lastUpdated="June 4, 2026">
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

      <LegalSection title="5. Third-party media and YouTube API">
        <p className="mb-3">
          The Service may incorporate stock footage, images, licensed media, and Creative Commons YouTube
          clips discovered via the YouTube Data API. Such materials remain subject to their respective
          licenses and terms:
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            YouTube-related features use the YouTube Data API in compliance with the{" "}
            <a
              href="https://developers.google.com/youtube/terms/api-services-terms-of-service"
              className="text-cyan-400 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              YouTube API Services Terms of Service
            </a>
            .
          </li>
          <li>
            You must not use the Service to download, redistribute, or re-upload YouTube content outside
            permitted licenses, or to circumvent YouTube or third-party access controls.
          </li>
          <li>
            We do not guarantee that any specific clip, person, or event will be available for a given prompt.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Intellectual property">
        <p>
          The Service, including software, branding, and documentation, is owned by Fastvid or its
          licensors. Except for rights expressly granted here, no rights are transferred to you. Generated
          outputs are provided for your use according to your plan; underlying third-party media may
          impose additional attribution or usage requirements.
        </p>
      </LegalSection>

      <LegalSection title="7. Disclaimers">
        <p>
          The Service and generated content are provided &quot;as is&quot; and &quot;as available&quot; without warranties of
          any kind, whether express or implied, including merchantability, fitness for a particular purpose,
          and non-infringement. We do not warrant that outputs will be error-free, unique, factually accurate,
          or suitable for any particular commercial purpose without your own review.
        </p>
      </LegalSection>

      <LegalSection title="8. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Fastvid and its affiliates will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for loss of profits, data,
          or goodwill, arising from your use of the Service. Our total liability for claims relating to the
          Service in any twelve-month period is limited to the amount you paid us for the Service in that
          period, or one hundred euros (€100), whichever is greater, unless mandatory law requires otherwise.
        </p>
      </LegalSection>

      <LegalSection title="9. Suspension and termination">
        <p>
          We may suspend or terminate access if you breach these Terms, abuse the Service, or if required
          by law. You may stop using the Service at any time. Provisions that by nature should survive
          termination (including intellectual property, disclaimers, and liability limits) will survive.
        </p>
      </LegalSection>

      <LegalSection title="10. Changes">
        <p>
          We may update these Terms from time to time. The &quot;Last updated&quot; date at the top of this page
          will change when we do. Continued use after changes constitutes acceptance of the revised Terms.
        </p>
      </LegalSection>

      <LegalSection title="11. Governing law">
        <p>
          These Terms are governed by the laws of the Netherlands, without regard to conflict-of-law rules,
          unless mandatory consumer protection laws in your country require otherwise. Disputes shall be
          submitted to the competent courts in the Netherlands, unless applicable law grants you the right
          to bring claims in your country of residence.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact">
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
