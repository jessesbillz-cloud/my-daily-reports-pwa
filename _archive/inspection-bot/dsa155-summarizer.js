const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const DOCS_PATH = process.env.DOCS_PATH || '/Users/jessesaltzman/Desktop/projects';

/**
 * Project-specific grouping patterns
 */
const PROJECT_GROUPINGS = {
  'woodland park': {
    type: 'building',
    groups: {
      'Building H': ['building h', 'bldg h', 'bldg. h', 'h building'],
      'Building D5': ['building d5', 'bldg d5', 'd5', 'd-5'],
      'Site': ['site work', 'sitework', 'grading', 'utilities', 'storm drain', 'hardscape', 'paving', 'underground']
    },
    default: 'General'
  },
  'oceanside': {
    type: 'trade',
    groups: {
      'Concrete': ['concrete', 'pour', 'slab', 'foundation', 'footing', 'grade beam', 'sog'],
      'Structural Steel': ['steel', 'framing', 'moment frame', 'connection', 'welding'],
      'MEP': ['mechanical', 'electrical', 'plumbing', 'hvac', 'conduit', 'pipe'],
      'Masonry': ['masonry', 'cmu', 'block', 'grout']
    },
    default: 'General'
  }
};

/**
 * Parse date from DR filename
 * Format: DR_##__Project_Name_Mon_DD_YYYY.docx
 */
function parseDRDate(filename) {
  const match = filename.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)_(\d{1,2})_(\d{4})/i);
  if (!match) return null;
  
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[match[1].toLowerCase()];
  const day = parseInt(match[2]);
  const year = parseInt(match[3]);
  
  return new Date(year, month, day);
}

/**
 * Find daily reports within date range
 */
async function findDRsInRange(projectFolder, startDate, endDate) {
  const drPath = path.join(DOCS_PATH, projectFolder, 'Daily_Reports');
  
  try {
    const files = await fs.readdir(drPath);
    const drFiles = files
      .filter(f => f.startsWith('DR_') && f.endsWith('.docx') && !f.includes('.backup'))
      .map(f => ({ filename: f, date: parseDRDate(f) }))
      .filter(f => f.date && f.date >= startDate && f.date <= endDate)
      .sort((a, b) => a.date - b.date);
    
    return drFiles.map(f => ({
      filename: f.filename,
      filepath: path.join(drPath, f.filename),
      date: f.date
    }));
  } catch (error) {
    throw new Error(`Error reading Daily_Reports folder: ${error.message}`);
  }
}

/**
 * Extract notes from a daily report
 */
async function extractNotesFromDR(filepath, projectConfig) {
  const pythonScript = `
from docx import Document
import sys

doc = Document(sys.argv[1])
table_idx = int(sys.argv[2])
row_idx = int(sys.argv[3])
cell_idx = int(sys.argv[4])
preserved = sys.argv[5] if len(sys.argv) > 5 else ''

cell = doc.tables[table_idx].rows[row_idx].cells[cell_idx]

notes = []
for para in cell.paragraphs:
    text = para.text.strip()
    if text and text.rstrip('.') != preserved.rstrip('.'):
        # Remove bullet prefix if present
        if text.startswith('•') or text.startswith('-'):
            text = text[1:].strip()
        if text:
            notes.append(text)

for note in notes:
    print(note)
`;

  const scriptPath = '/tmp/extract_notes.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  const preserved = projectConfig.preserved_text || '';
  
  try {
    const cmd = `python3 ${scriptPath} "${filepath}" ${projectConfig.notes_table_index} ${projectConfig.notes_row_index} ${projectConfig.notes_cell_index} "${preserved}"`;
    const { stdout } = await execAsync(cmd);
    return stdout.trim().split('\n').filter(n => n.trim());
  } catch (error) {
    console.error(`Error extracting notes from ${filepath}: ${error.message}`);
    return [];
  }
}

/**
 * Categorize a note into a group
 */
function categorizeNote(note, projectKey) {
  const grouping = PROJECT_GROUPINGS[projectKey];
  if (!grouping) return 'General';
  
  const noteLower = note.toLowerCase();
  
  for (const [groupName, keywords] of Object.entries(grouping.groups)) {
    for (const keyword of keywords) {
      if (noteLower.includes(keyword)) {
        return groupName;
      }
    }
  }
  
  return grouping.default;
}

/**
 * Main function: Generate summary from daily reports in date range
 */
async function generatePeriodSummary(projectKey, projectConfig, startDate, endDate) {
  // Find DRs in range
  const drFiles = await findDRsInRange(projectConfig.folder, startDate, endDate);
  
  if (drFiles.length === 0) {
    return { grouped: {}, raw: [], drCount: 0 };
  }
  
  // Extract all notes
  const allNotes = [];
  for (const dr of drFiles) {
    const notes = await extractNotesFromDR(dr.filepath, projectConfig);
    allNotes.push(...notes);
  }
  
  // Group by building/trade
  const grouped = {};
  for (const note of allNotes) {
    const group = categorizeNote(note, projectKey);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(note);
  }
  
  return {
    grouped,
    raw: allNotes,
    drCount: drFiles.length,
    startDate,
    endDate
  };
}

module.exports = {
  generatePeriodSummary,
  findDRsInRange,
  extractNotesFromDR,
  PROJECT_GROUPINGS
};

const Anthropic = require('@anthropic-ai/sdk');

/**
 * Format grouped notes into DSA 155 summary using Claude API
 */
async function formatSummaryForDSA155(grouped, projectKey) {
  const client = new Anthropic();
  
  const grouping = PROJECT_GROUPINGS[projectKey];
  const groupType = grouping?.type === 'building' ? 'building/area' : 'trade';
  
  let summaryText = '';
  
  for (const [group, notes] of Object.entries(grouped)) {
    if (notes.length === 0) continue;
    
    const prompt = `You are summarizing construction inspection notes for a DSA 155 semi-monthly report.

Notes for ${group}:
${notes.map(n => '- ' + n).join('\n')}

Write a factual 1-3 sentence summary of work status. Rules:
- Facts only, no fluff or narrative
- Use past tense for completed work, present for ongoing
- No "successfully" or "excellent" or any sugar coating
- Inspector language: checked, reviewed, verified, observed, noted, alerted
- Be specific about what was inspected or observed
- If notes mention issues or alerts, include them

Return ONLY the summary text, nothing else.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const groupSummary = response.content[0].text.trim();
    summaryText += `${group} - ${groupSummary}\n\n`;
  }
  
  return summaryText.trim();
}

module.exports.formatSummaryForDSA155 = formatSummaryForDSA155;


/**
 * DSA 155 project-specific info
 */
const DSA_PROJECT_INFO = {
  'woodland park': {
    region: '04',
    appNum: '124358',
    dsa_file1: '37',
    dsa_file2: '62',
    school_district: 'San Marcos Unified School District',
    project_name: 'Woodland Park Middle School',
    inspector_name: 'Jesse Saltzman',
    cert_num: '6160',
    card_nums: '7, 10, SW'
  },
  'oceanside': {
    region: '04',
    appNum: '124358',  // update with actual
    dsa_file1: '37',   // update with actual
    dsa_file2: '46',   // update with actual
    school_district: 'Oceanside Unified School District',
    project_name: 'Oceanside District Office',
    inspector_name: 'Jesse Saltzman',
    cert_num: '6160',
    card_nums: ''      // update with actual
  }
};

/**
 * Get next report number by checking existing 155s
 */
async function getNextReportNumber(projectKey) {
  const info = DSA_PROJECT_INFO[projectKey];
  const dsaPath = path.join(DOCS_PATH, 
    projectKey === 'woodland park' ? 'Woodland_Park' : 'Oceanside', 
    'DSA_Forms', '155');
  
  try {
    const files = await fs.readdir(dsaPath);
    const reportNums = files
      .filter(f => f.includes('_155_') && f.endsWith('.pdf'))
      .map(f => {
        // Extract report number from filled PDFs if stored, otherwise count files
        return 1;
      });
    return String(files.length + 1).padStart(2, '0');
  } catch {
    return '01';
  }
}

/**
 * Format date for 155 fields (Mon DD, YYYY)
 */
function formatDateFor155(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}, ${date.getFullYear()}`;
}

/**
 * Format date for filename (YY-MM-DD)
 */
function formatDateForFilename(date) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Fill DSA 155 PDF with summary using Python fillpdf
 */
async function fillDSA155(projectKey, summary, periodStart, periodEnd, formDate) {
  const info = DSA_PROJECT_INFO[projectKey];
  if (!info) throw new Error(`No DSA info for project: ${projectKey}`);
  
  const projectFolder = projectKey === 'woodland park' ? 'Woodland_Park' : 'Oceanside';
  const dsaPath = path.join(DOCS_PATH, projectFolder, 'DSA_Forms', '155');
  
  // Find most recent 155 as template
  const files = await fs.readdir(dsaPath);
  const pdfFiles = files.filter(f => f.includes('_155_') && f.endsWith('.pdf')).sort().reverse();
  
  if (pdfFiles.length === 0) throw new Error('No 155 template found');
  
  const templatePath = path.join(dsaPath, pdfFiles[0]);
  const reportNum = await getNextReportNumber(projectKey);
  const newFilename = `${info.region}-${info.appNum}_155_${formatDateForFilename(formDate)}_${info.cert_num}_.pdf`;
  const outputPath = path.join(dsaPath, newFilename);
  
  const pythonScript = `
from fillpdf import fillpdfs
import sys
import json

template = sys.argv[1]
output = sys.argv[2]
data = json.loads(sys.argv[3])

fillpdfs.write_fillable_pdf(template, output, data)
print('SUCCESS')
`;

  const scriptPath = '/tmp/fill_155.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  const formData = {
    'From': formatDateFor155(periodStart),
    'To': formatDateFor155(periodEnd),
    'Date of Report': formatDateFor155(formDate),
    'Report': reportNum,
    'STATUS OF CONSTRUCTION WORK Provide a brief description of work in progress including a listing of fabrication work performed offsite Attach additional pages if necessary': summary
  };
  
  const dataJson = JSON.stringify(formData).replace(/"/g, '\\"');
  
  try {
    const cmd = `python3 ${scriptPath} "${templatePath}" "${outputPath}" "${dataJson}"`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
    
    return {
      filepath: outputPath,
      filename: newFilename,
      reportNum
    };
  } catch (error) {
    throw new Error(`Failed to fill PDF: ${error.message}`);
  }
}

module.exports.fillDSA155 = fillDSA155;
module.exports.DSA_PROJECT_INFO = DSA_PROJECT_INFO;
