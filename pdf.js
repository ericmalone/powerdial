// Builds the signed funding application PDF that goes to lenders
const PDFDocument = require('pdfkit');

const COMPANY = () => process.env.COMPANY_NAME || 'Brookestone Funding';
const AUTH_TEXT = () => `By signing below, the business and each owner listed above (together, "Applicant") certify that the information in this application and all documents provided are true and complete. Applicant authorizes ${COMPANY()} and its funding partners, agents and assigns to obtain business and personal credit reports, verify any information provided (including bank and trade references), and share this application and supporting documents with funding partners for the purpose of evaluating a business funding request. This authorization remains valid for the life of any resulting agreement and for future funding requests. A copy of this authorization is as valid as the original.`;

const SECTIONS = [
  ['Business', [['legal_name', 'Legal name'], ['dba', 'DBA'], ['ein', 'EIN / Tax ID'], ['entity_type', 'Entity type'], ['start_date', 'Business start date'], ['industry', 'Industry'],
    ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['business_phone', 'Business phone'], ['website', 'Website']]],
  ['Funding request', [['amount_requested', 'Amount requested'], ['use_of_funds', 'Use of funds'], ['monthly_revenue', 'Avg. monthly revenue'], ['existing_positions', 'Open advances / loans'], ['existing_lenders', 'Current lenders & balances']]],
  ['Owner', [['owner_name', 'Name'], ['owner_title', 'Title'], ['ownership_pct', 'Ownership %'], ['owner_email', 'Email'], ['owner_cell', 'Cell'],
    ['owner_address', 'Home address'], ['owner_city', 'City'], ['owner_state', 'State'], ['owner_zip', 'ZIP'], ['owner_dob', 'Date of birth'], ['owner_ssn', 'SSN'], ['fico_estimate', 'Est. credit score']]],
  ['Bank', [['bank_name', 'Business bank']]],
];

// app = decrypted application answers; returns Promise<Buffer>
function applicationPdf(app, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).text(`${COMPANY()} — Business Funding Application`);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`Deal #${opts.dealId || ''} · Generated ${new Date().toLocaleString('en-US')}`).fillColor('#000');
    doc.moveDown(0.8);
    for (const [title, fields] of SECTIONS) {
      const rows = fields.filter(([k]) => app[k] != null && String(app[k]).trim() !== '');
      if (!rows.length) continue;
      doc.font('Helvetica-Bold').fontSize(11).text(title.toUpperCase()); doc.moveDown(0.2);
      doc.moveTo(48, doc.y).lineTo(564, doc.y).strokeColor('#ccc').stroke(); doc.moveDown(0.3);
      for (const [k, label] of rows) {
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, 48, y, { width: 150 });
        doc.font('Helvetica').fontSize(10).fillColor('#000').text(fmt(k, app[k]), 205, y, { width: 359 });
        doc.moveDown(0.25);
      }
      doc.moveDown(0.6);
    }
    doc.font('Helvetica-Bold').fontSize(11).text('AUTHORIZATION'); doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8.5).text(AUTH_TEXT(), { align: 'justify' });
    doc.moveDown(0.8);
    if (app.signature && /^data:image\/png;base64,/.test(app.signature)) {
      try { doc.image(Buffer.from(app.signature.split(',')[1], 'base64'), { fit: [220, 70] }); } catch {}
    }
    doc.font('Helvetica').fontSize(10).text(`Signed: ${app.signed_name || ''}`);
    doc.fontSize(9).fillColor('#555').text(`Date: ${app.signed_at ? new Date(app.signed_at).toLocaleString('en-US') : ''}   ·   IP: ${app.signed_ip || ''}`);
    doc.end();
  });
}
function fmt(k, v) {
  if (['amount_requested', 'monthly_revenue'].includes(k) && !isNaN(Number(String(v).replace(/[$,]/g, '')))) return '$' + Number(String(v).replace(/[$,]/g, '')).toLocaleString('en-US');
  return String(v);
}

function contractPdf(o) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).text(o.title || 'Funding Agreement');
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`${o.company || COMPANY()} · Deal #${o.dealId || ''} · ${o.signed ? 'Signed copy' : 'Unsigned draft'}`).fillColor('#000');
    doc.moveDown(0.8);
    if (o.terms && o.terms.length) {
      doc.font('Helvetica-Bold').fontSize(11).text('KEY TERMS'); doc.moveDown(0.2);
      doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ccc').stroke(); doc.moveDown(0.3);
      for (const [k, v] of o.terms) { const y = doc.y; doc.font('Helvetica').fontSize(9.5).fillColor('#555').text(k, 54, y, { width: 170 }); doc.fillColor('#000').text(String(v), 230, y, { width: 328 }); doc.moveDown(0.2); }
      doc.moveDown(0.8);
    }
    doc.font('Helvetica').fontSize(9.5).text(String(o.body || ''), 54, doc.y, { align: 'justify', width: 504 });
    doc.moveDown(1.2);
    if (doc.y > 640) doc.addPage();
    if (o.sig && o.sig.image && /^data:image\/png;base64,/.test(o.sig.image)) { try { doc.image(Buffer.from(o.sig.image.split(',')[1], 'base64'), { fit: [220, 70] }); } catch {} }
    if (o.sig) {
      doc.font('Helvetica').fontSize(10).text(`Signed by: ${o.sig.name || ''}`);
      doc.fontSize(9).fillColor('#555').text(`Date: ${o.sig.at ? new Date(o.sig.at).toLocaleString('en-US') : ''}   ·   IP: ${o.sig.ip || ''}`);
    } else doc.font('Helvetica').fontSize(10).text('Signature: ______________________________   Date: ______________');
    doc.end();
  });
}
module.exports = { contractPdf, applicationPdf, AUTH_TEXT, SECTIONS };
