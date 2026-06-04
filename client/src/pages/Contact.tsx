import { Mail, MessageSquare, Shield } from "lucide-react";
import { LegalPageShell, LegalSection } from "@/components/LegalPageShell";

const CONTACT_CHANNELS = [
  {
    icon: Mail,
    title: "General support",
    description: "Help with your account, billing, or using the video generator.",
    email: "support@fastvid.app",
  },
  {
    icon: Shield,
    title: "Privacy & data",
    description: "Requests about personal data, deletion, or our Privacy Policy.",
    email: "privacy@fastvid.app",
  },
  {
    icon: MessageSquare,
    title: "Legal & terms",
    description: "Questions about our Terms of Service or compliance.",
    email: "legal@fastvid.app",
  },
] as const;

export default function Contact() {
  return (
    <LegalPageShell title="Contact" lastUpdated="June 4, 2026">
      <p>
        We&apos;re here to help. Choose the channel that best matches your question. We aim to respond
        within a few business days.
      </p>

      <div className="grid gap-4 not-prose">
        {CONTACT_CHANNELS.map(({ icon: Icon, title, description, email }) => (
          <div
            key={email}
            className="glass-card border border-white/8 rounded-xl p-5 flex gap-4 items-start"
          >
            <div className="shrink-0 w-10 h-10 rounded-lg bg-purple-600/20 flex items-center justify-center">
              <Icon className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white mb-1">{title}</h2>
              <p className="text-sm text-slate-400 mb-2">{description}</p>
              <a href={`mailto:${email}`} className="text-sm text-cyan-400 hover:underline font-medium">
                {email}
              </a>
            </div>
          </div>
        ))}
      </div>

      <LegalSection title="Invite codes">
        <p>
          New accounts may require an invite code. If you need access, email{" "}
          <a href="mailto:support@fastvid.app" className="text-cyan-400 hover:underline">
            support@fastvid.app
          </a>{" "}
          with a short description of how you plan to use Fastvid.
        </p>
      </LegalSection>

      <LegalSection title="Related pages">
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <a href="/privacy" className="text-cyan-400 hover:underline">
              Privacy Policy
            </a>
          </li>
          <li>
            <a href="/terms" className="text-cyan-400 hover:underline">
              Terms of Service
            </a>
          </li>
          <li>
            <a href="/cookie-policy" className="text-cyan-400 hover:underline">
              Cookie Policy
            </a>
          </li>
        </ul>
      </LegalSection>
    </LegalPageShell>
  );
}
