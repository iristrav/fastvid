import { LegalPageShell, LegalSection } from "@/components/LegalPageShell";
import { FASTVID_CONTACT_EMAIL } from "@shared/const";

export default function CookiePolicy() {
  return (
    <LegalPageShell title="Cookie Policy" lastUpdated="June 4, 2026">
      <p>
        This Cookie Policy explains how Fastvid (&quot;we&quot;, &quot;us&quot;) uses cookies and similar
        technologies on our website and application. It should be read together with our{" "}
        <a href="/privacy" className="text-cyan-400 hover:underline">
          Privacy Policy
        </a>
        .
      </p>

      <LegalSection title="1. What are cookies?">
        <p>
          Cookies are small text files stored on your device when you visit a site. Similar technologies
          (such as local storage) may be used for the same purposes described below.
        </p>
      </LegalSection>

      <LegalSection title="2. Cookies we use">
        <ul className="list-disc pl-5 space-y-3">
          <li>
            <strong className="text-slate-200">Strictly necessary:</strong> session and authentication
            cookies so you can log in securely and stay signed in while using the dashboard. These are
            required for the Service to function.
          </li>
          <li>
            <strong className="text-slate-200">Preferences:</strong> optional settings we may store locally
            (for example theme or UI preferences) to improve your experience.
          </li>
          <li>
            <strong className="text-slate-200">Analytics:</strong> we do not currently use third-party
            advertising or cross-site tracking cookies. If we introduce privacy-friendly analytics in the
            future, we will update this page and, where required, ask for consent before non-essential
            cookies are set.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Third-party content">
        <p>
          Embedded media or external links (for example documentation or payment pages) may set their own
          cookies under their providers&apos; policies. We do not control those cookies.
        </p>
      </LegalSection>

      <LegalSection title="4. How to manage cookies">
        <p>
          You can block or delete cookies through your browser settings. Blocking strictly necessary cookies
          may prevent you from logging in or using core features. For questions about data we hold about
          you, see our Privacy Policy or contact us.
        </p>
      </LegalSection>

      <LegalSection title="5. Changes">
        <p>
          We may update this Cookie Policy from time to time. The &quot;Last updated&quot; date above will
          change when we do.
        </p>
      </LegalSection>

      <LegalSection title="6. Contact">
        <p>
          Questions about cookies:{" "}
          <a href={`mailto:${FASTVID_CONTACT_EMAIL}`} className="text-cyan-400 hover:underline">
            {FASTVID_CONTACT_EMAIL}
          </a>
          . General inquiries:{" "}
          <a href="/contact" className="text-cyan-400 hover:underline">
            Contact
          </a>
          .
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
