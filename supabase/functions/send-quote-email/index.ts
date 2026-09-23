// send-quote-email
//
// Every customer email that carries a quote goes out through here: the quote
// itself, the three follow-ups, the acceptance note and the review request.
// The Resend key stays server-side and the caller is checked against the job's
// company, so a staff login can only ever email its own customers.
//
// POST {
//   job_id, to, subject, body_html,
//   pdf_base64?, pdf_filename?,
//   accept_url?      -> adds the Review & Accept button under the message
//   archive_pdf?     -> keeps a copy of the attachment for the accept page
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FROM = "Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      job_id, to, subject, body_html, pdf_base64, pdf_filename,
      accept_url, archive_pdf,
    } = await req.json();
    if (!job_id || !to) return json({ error: "Missing job_id or to" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_ANON_KEY"),
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: profile } = await admin.from("app_users").select("company_id, name").eq("id", user.id).single();
    if (!profile?.company_id) return json({ error: "No company profile" }, 403);

    const { data: job } = await admin.from("jobs").select("id, company_id, quote_number, data").eq("id", job_id).single();
    if (!job) return json({ error: "Job not found" }, 404);
    if (job.company_id !== profile.company_id) return json({ error: "Forbidden: job belongs to another company" }, 403);

    const { data: company } = await admin.from("companies").select("name, contact_email").eq("id", job.company_id).single();
    const cc = company?.contact_email ? [company.contact_email] : [];
    const finalSubject = subject || `Quote ${job.quote_number} — ${company?.name ?? "Dr Drapes"}`;

    const html = (body_html || "<p>Please find your quote attached.</p>")
      + (accept_url ? acceptBlock(accept_url) : "");

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [to], cc, reply_to: "drdrapes@hudsongroup.com.au",
        subject: finalSubject,
        html,
        ...(pdf_base64 ? { attachments: [{ filename: pdf_filename || `${job.quote_number || "Quote"}.pdf`, content: pdf_base64 }] } : {}),
      }),
    });
    if (!resendRes.ok) { const detail = await resendRes.text(); return json({ error: "Resend failed", detail }, 502); }

    const sentAt = new Date().toISOString();
    const data = job.data ?? {};
    data.quote = data.quote ?? {};
    data.quote.email_log = data.quote.email_log ?? [];
    data.quote.email_log.push({ sent_at: sentAt, to, cc: cc[0] ?? null, subject: finalSubject });

    // Keep the attachment the customer just received, so the Download button
    // on the accept page hands back that same document rather than a second
    // rendering of it made from whatever the quote says a month later.
    // Best effort: a storage hiccup must never fail an email that already went.
    if (archive_pdf && pdf_base64) {
      try {
        const path = `${job.company_id}/${job.id}/${(job.quote_number || "quote").replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}.pdf`;
        const bytes = Uint8Array.from(atob(pdf_base64), (c) => c.charCodeAt(0));
        const { error: upErr } = await admin.storage.from("quote-pdfs")
          .upload(path, bytes, { contentType: "application/pdf", upsert: false });
        if (upErr) console.error("quote pdf archive failed", upErr);
        else data.quote.pdf_path = path;
      } catch (e) {
        console.error("quote pdf archive threw", e);
      }
    }

    await admin.from("jobs").update({ data }).eq("id", job.id);

    return json({ ok: true, sent_at: sentAt });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// The one thing in the email the customer is meant to act on, so it is the one
// thing that looks like a button. The plain link underneath is for the clients
// that strip the styling and for anyone who wants to see where it goes first.
function acceptBlock(url) {
  const safe = String(url).replace(/"/g, "&quot;");
  return `
<table style="width:100%;border-collapse:collapse;margin:26px 0 8px">
  <tr><td style="border-top:1px solid #e2e8e7;padding-top:22px">
    <div style="text-align:center">
      <a href="${safe}" style="display:inline-block;background:#0F6E63;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;font-family:Arial,Helvetica,sans-serif">Review &amp; accept your quote</a>
      <div style="color:#5A6866;font-size:12.5px;font-family:Arial,Helvetica,sans-serif;margin:12px 0 0">
        Accept it online whenever suits — or decline it, or ask us a question.
      </div>
      <div style="color:#9aa5a3;font-size:11px;font-family:Arial,Helvetica,sans-serif;margin:10px 0 0;word-break:break-all">${safe}</div>
    </div>
  </td></tr>
</table>`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
