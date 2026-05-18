import { ENV } from "./env";

export async function sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<boolean> {
  try {
    if (!ENV.resendApiKey) {
      console.warn("[Password Reset] Resend API key not configured, skipping email");
      return false;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.resendApiKey}`,
      },
      body: JSON.stringify({
        from: "noreply@fastvid.app",
        to: email,
        subject: "Reset your Fastvid password",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%); padding: 40px 20px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 28px;">Fastvid</h1>
            </div>
            <div style="background: #f9fafb; padding: 40px 20px; border-radius: 0 0 8px 8px;">
              <h2 style="color: #1f2937; margin-top: 0;">Reset your password</h2>
              <p style="color: #6b7280; line-height: 1.6;">
                We received a request to reset your password. Click the button below to create a new password.
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                  Reset Password
                </a>
              </div>
              <p style="color: #6b7280; font-size: 14px;">
                Or copy and paste this link in your browser:
              </p>
              <p style="color: #06b6d4; word-break: break-all; font-size: 12px;">
                ${resetUrl}
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
              <p style="color: #9ca3af; font-size: 12px;">
                This link will expire in 1 hour. If you didn't request a password reset, please ignore this email.
              </p>
            </div>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("[Password Reset] Resend API error:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Password Reset] Failed to send email:", error);
    return false;
  }
}
