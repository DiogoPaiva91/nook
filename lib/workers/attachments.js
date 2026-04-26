const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function extractText(att) {
  try {
    if (att.kind === "pdf") {
      const out = execSync("pdftotext " + JSON.stringify(att.path) + " -", {
        timeout: 5000,
        maxBuffer: 200 * 1024,
      });
      return out.toString("utf8").slice(0, 50000);
    }
    return fs.readFileSync(att.path, "utf8").slice(0, 50000);
  } catch {
    return null;
  }
}

function buildAttachmentBlock(att) {
  if (att.kind === "image") return "[Imagem anexada: " + att.path + "]\n";
  const text = extractText(att);
  if (text == null) {
    return "[ANEXO: " + att.filename + " (" + att.kind + " - nao extraivel)]\n\n";
  }
  const ext = path.extname(att.filename || "").replace(".", "");
  const fence = att.kind === "pdf" ? "" : ext;
  return "[ANEXO: " + att.filename + "]\n```" + fence + "\n" + text + "\n```\n\n";
}

function readImageBase64(att) {
  try {
    return fs.readFileSync(att.path).toString("base64");
  } catch {
    return null;
  }
}

function enrichHistoryForClaude(history) {
  return history.map((m) => {
    const atts = m.metadata && Array.isArray(m.metadata.attachments) ? m.metadata.attachments : null;
    if (!atts || !atts.length || m.role !== "user") {
      return { role: m.role, content: m.content };
    }
    let extra = "";
    for (const att of atts) extra += buildAttachmentBlock(att);
    return { role: m.role, content: extra + (m.content || "") };
  });
}

function enrichHistoryForOllama(history) {
  return history.map((m) => {
    const atts = m.metadata && Array.isArray(m.metadata.attachments) ? m.metadata.attachments : null;
    if (!atts || !atts.length || m.role !== "user") {
      return { role: m.role, content: m.content };
    }
    let extra = "";
    const images = [];
    for (const att of atts) {
      if (att.kind === "image") {
        const b64 = readImageBase64(att);
        if (b64) images.push(b64);
      } else {
        extra += buildAttachmentBlock(att);
      }
    }
    const out = { role: m.role, content: extra + (m.content || "") };
    if (images.length) out.images = images;
    return out;
  });
}

module.exports = { enrichHistoryForClaude, enrichHistoryForOllama };
