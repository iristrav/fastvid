/**
 * Email service helper using Resend API
 * Handles password reset emails and other transactional emails
 */

import { FASTVID_CONTACT_EMAIL } from "@shared/const";
import { getConfiguredAppUrl } from "./appUrl";
import { ONBOARDING_APPROVED_MESSAGE } from "@shared/nicheRequest";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

function emailFromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || "Fastvid <noreply@fastvid.tech>";
}

/**
 * Send an email using Resend API
 * Requires RESEND_API_KEY environment variable
 */
export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not configured, skipping email send");
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFromAddress(),
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[Email] Failed to send email:", error);
      return false;
    }

    console.log("[Email] Email sent successfully to", opts.to);
    return true;
  } catch (error) {
    console.error("[Email] Error sending email:", error);
    return false;
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(email: string, resetLink: string): Promise<boolean> {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 20px 0; }
          .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
          .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Reset Your Password</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <a href="${resetLink}" class="button">Reset Password</a>
            <p>Or copy this link: <code>${resetLink}</code></p>
            <div class="warning">
              <strong>⚠️ This link expires in 1 hour.</strong> If you didn't request a password reset, you can safely ignore this email.
            </div>
            <p>Questions? Contact us at ${FASTVID_CONTACT_EMAIL}</p>
          </div>
          <div class="footer">
            <p>&copy; 2026 Fastvid. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: email,
    subject: "Reset Your Fastvid Password",
    html,
  });
}

function appBaseUrl(): string {
  return getConfiguredAppUrl() ?? "https://www.fastvid.tech";
}

/**
 * Notify applicant that their niche request was approved.
 */
export async function sendNicheApprovedEmail(opts: {
  to: string;
  nicheTitle: string;
  requestType: "onboarding" | "new_channel";
}): Promise<boolean> {
  const baseUrl = appBaseUrl();
  const dashboardUrl = `${baseUrl}/dashboard/niche-requests`;
  const subscribeUrl = `${baseUrl}/subscribe`;
  const isOnboarding = opts.requestType === "onboarding";

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 20px 0; }
          .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
          .niche { background: #ede9fe; border-left: 4px solid #7c3aed; padding: 15px; margin: 20px 0; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Your niche is approved</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <p>Good news — your Fastvid niche request has been <strong>approved</strong>.</p>
            <div class="niche">
              <strong>Niche:</strong> ${escapeHtml(opts.nicheTitle)}
            </div>
            <p>${ONBOARDING_APPROVED_MESSAGE}</p>
            ${
              isOnboarding
                ? `<p>Activate your subscription to start generating videos:</p>
                   <a href="${subscribeUrl}" class="button">Activate subscription</a>`
                : `<p>Your new channel niche is ready. Open your dashboard to start generating:</p>
                   <a href="${dashboardUrl}" class="button">Go to dashboard</a>`
            }
            <p>Questions? Contact us at ${FASTVID_CONTACT_EMAIL}</p>
          </div>
          <div class="footer">
            <p>&copy; 2026 Fastvid. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: opts.to,
    subject: `Your Fastvid niche "${opts.nicheTitle}" is approved`,
    html,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
