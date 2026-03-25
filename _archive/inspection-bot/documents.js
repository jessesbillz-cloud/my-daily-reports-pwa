const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType } = require('docx');
const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');

const DOCS_PATH = process.env.DOCS_PATH;

/**
 * Find today's DR file or determine next sequential number
 */
async function findTodaysDR(projectConfig) {
  const projectPath = path.join(DOCS_PATH, projectConfig.folder);
  const today = new Date();
  const todayStr = format(today, 'MMM_DD_yyyy'); // e.g., Jan_25_2026
  
  try {
    const files = await fs.readdir(projectPath);
    
    // Look for today's file
    const todayFile = files.find(f => f.includes(todayStr) && f.endsWith('.docx') && !f.includes('.backup'));
    
    if (todayFile) {
      return {
        exists: true,
        filepath: path.join(projectPath, todayFile),
        filename: todayFile
      };
    }
    
    // Find highest DR number
    const drNumbers = files
      .filter(f => f.startsWith('DR_') && f.endsWith('.docx') && !f.includes('.backup'))
      .map(f => {
        const match = f.match(/DR_(\d+)/);
        return match ? parseInt(match[1]) : 0;
      });
    
    const nextNumber = drNumbers.length > 0 ? Math.max(...drNumbers) + 1 : 1;
    const newFilename = `DR_${String(nextNumber).padStart(2, '0')}__${projectConfig.folder}_${todayStr}.docx`;
    
    return {
      exists: false,
      filepath: path.join(projectPath, newFilename),
      filename: newFilename,
      nextNumber
    };
    
  } catch (error) {
    throw new Error(`Error accessing project folder: ${error.message}`);
  }
}

/**
 * Format date according to project config
 */
function formatDate(dateFormat) {
  const today = new Date();
  
  // Convert config format to date-fns format
  const formatMap = {
    'MMM DD, YYYY': 'MMM dd, yyyy',
    'DD MMM YYYY': 'dd MMM yyyy',
    'DD MMMM YYYY': 'dd MMMM yyyy',
    'MM/DD/YYYY': 'MM/dd/yyyy'
  };
  
  const fnsFormat = formatMap[dateFormat] || 'MMM dd, yyyy';
  return format(today, fnsFormat);
}

/**
 * Update dates in document
 */
async function updateDates(docPath, projectConfig) {
  // Use python-docx via child_process since docx package has limitations
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  const pythonScript = `
from docx import Document
from datetime import datetime
import sys

doc_path = sys.argv[1]
date_format = sys.argv[2]
locations = sys.argv[3]  # JSON string

doc = Document(doc_path)

# Format today's date
today = datetime.now()
if date_format == 'MMM DD, YYYY':
    date_str = today.strftime('%b %d, %Y')
elif date_format == 'DD MMM YYYY':
    date_str = today.strftime('%d %b %Y')
elif date_format == 'DD MMMM YYYY':
    date_str = today.strftime('%d %B %Y')
elif date_format == 'MM/DD/YYYY':
    date_str = today.strftime('%m/%d/%Y')
else:
    date_str = today.strftime('%b %d, %Y')

# Update date locations
import json
locs = json.loads(locations)

for loc in locs:
    table = doc.tables[loc['table']]
    cell = table.rows[loc['row']].cells[loc['cell']]
    
    # Clear cell and set new date
    for para in cell.paragraphs:
        para.clear()
    cell.paragraphs[0].add_run(date_str)

# Handle signature date if it exists
if 'signature_date_format' in sys.argv[4:]:
    sig_format = sys.argv[5]
    if sig_format == 'MM/DD/YYYY':
        sig_date = today.strftime('%m/%d/%Y')
        # Update signature location (typically last date location)
        if len(locs) > 1:
            loc = locs[-1]
            table = doc.tables[loc['table']]
            cell = table.rows[loc['row']].cells[loc['cell']]
            for para in cell.paragraphs:
                para.clear()
            cell.paragraphs[0].add_run(sig_date)

doc.save(doc_path)
print('SUCCESS')
`;
  
  const scriptPath = '/tmp/update_dates.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  const locationsJson = JSON.stringify(projectConfig.date_locations);
  const sigFormat = projectConfig.signature_date_format || '';
  
  try {
    const cmd = `python3 ${scriptPath} "${docPath}" "${projectConfig.date_format}" '${locationsJson}' ${sigFormat ? `signature_date_format "${sigFormat}"` : ''}`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
  } catch (error) {
    throw new Error(`Failed to update dates: ${error.message}`);
  }
}

/**
 * Update notes section in document
 */
async function updateNotes(docPath, projectConfig, notes) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  const pythonScript = `
from docx import Document
import sys

doc_path = sys.argv[1]
table_idx = int(sys.argv[2])
row_idx = int(sys.argv[3])
cell_idx = int(sys.argv[4])
keep_first = sys.argv[5] == 'true'
notes = sys.argv[6]
preserved = sys.argv[7] if len(sys.argv) > 7 else None

doc = Document(doc_path)

cell = doc.tables[table_idx].rows[row_idx].cells[cell_idx]

if keep_first and preserved:
    # Keep preserved text, add new notes
    new_text = preserved + "\\n\\n" + notes
else:
    # Replace everything
    header = "${projectConfig.notes_header}\\n\\n" if ${!!projectConfig.notes_header} else ""
    new_text = header + notes

# Clear and set
for para in cell.paragraphs:
    para.clear()
cell.paragraphs[0].add_run(new_text)

doc.save(doc_path)
print('SUCCESS')
`;
  
  const scriptPath = '/tmp/update_notes.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  const preserved = projectConfig.preserved_text || '';
  
  try {
    const cmd = `python3 ${scriptPath} "${docPath}" ${projectConfig.notes_table_index} ${projectConfig.notes_row_index} ${projectConfig.notes_cell_index} ${projectConfig.keep_first_paragraph} "${notes}" "${preserved}"`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
  } catch (error) {
    throw new Error(`Failed to update notes: ${error.message}`);
  }
}

/**
 * Add photo pages to document
 */
async function addPhotos(docPath, photos) {
  if (!photos || photos.length === 0) return;
  
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  // Save photos temporarily
  const tempPhotos = [];
  for (let i = 0; i < photos.length; i++) {
    const tempPath = `/tmp/photo_${i}.jpg`;
    await fs.writeFile(tempPath, photos[i]);
    tempPhotos.push(tempPath);
  }
  
  const pythonScript = `
from docx import Document
from docx.shared import Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import sys

doc_path = sys.argv[1]
photo_paths = sys.argv[2:]

doc = Document(doc_path)

for photo_path in photo_paths:
    # Add page break
    doc.add_page_break()
    
    # Add photo centered
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run()
    run.add_picture(photo_path, width=Inches(6))

doc.save(doc_path)
print('SUCCESS')
`;
  
  const scriptPath = '/tmp/add_photos.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  try {
    const cmd = `python3 ${scriptPath} "${docPath}" ${tempPhotos.join(' ')}`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
    
    // Clean up temp photos
    for (const tempPath of tempPhotos) {
      await fs.unlink(tempPath).catch(() => {});
    }
  } catch (error) {
    throw new Error(`Failed to add photos: ${error.message}`);
  }
}

/**
 * Create backup of document
 */
async function createBackup(filepath) {
  const backupPath = filepath.replace('.docx', '.backup.docx');
  await fs.copyFile(filepath, backupPath);
  return backupPath;
}

/**
 * Load project config
 */
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const configRaw = require('fs').readFileSync(configPath, 'utf8');
  return JSON.parse(configRaw);
}

/**
 * Clear notes section for a new report (keeps preserved text)
 */
async function clearNotesForNewReport(docPath, projectConfig) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  const preserved = (projectConfig.preserved_text || '').replace(/'/g, "'\\''");
  
  const pythonScript = `
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_LINE_SPACING
import sys

doc_path = sys.argv[1]
table_idx = int(sys.argv[2])
row_idx = int(sys.argv[3])
cell_idx = int(sys.argv[4])
preserved_text = sys.argv[5] if len(sys.argv) > 5 else ''

doc = Document(doc_path)
cell = doc.tables[table_idx].rows[row_idx].cells[cell_idx]

# Clear all paragraphs
for para in cell.paragraphs:
    p = para._element
    p.getparent().remove(p)

# Add preserved text if exists
if preserved_text:
    p = cell.add_paragraph()
    p.add_run(preserved_text)
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE

doc.save(doc_path)
print('SUCCESS')
`;
  
  const scriptPath = '/tmp/clear_notes.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  try {
    const cmd = `python3 ${scriptPath} "${docPath}" ${projectConfig.notes_table_index} ${projectConfig.notes_row_index} ${projectConfig.notes_cell_index} '${preserved}'`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
  } catch (error) {
    throw new Error(`Failed to clear notes: ${error.message}`);
  }
}

/**
 * Append a single note to today's report
 */
async function appendNoteToDoc(docPath, projectConfig, noteText) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  // Escape the note text for shell
  const escapedNote = noteText.replace(/'/g, "'\\''");
  const preserved = (projectConfig.preserved_text || '').replace(/'/g, "'\\''");
  
  const pythonScript = `
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_LINE_SPACING
import sys

doc_path = sys.argv[1]
table_idx = int(sys.argv[2])
row_idx = int(sys.argv[3])
cell_idx = int(sys.argv[4])
new_note = sys.argv[5]
preserved_text = sys.argv[6] if len(sys.argv) > 6 else ''

doc = Document(doc_path)
cell = doc.tables[table_idx].rows[row_idx].cells[cell_idx]

# Get existing bullet notes (skip preserved text and empty lines)
existing_bullets = []
for para in cell.paragraphs:
    text = para.text.strip()
    if text and text != preserved_text:
        # Keep existing bullets
        if text.startswith('•') or text.startswith('-'):
            existing_bullets.append(text)
        elif text and not text.startswith('NOTES:'):
            # Non-bullet text that's not header - convert to bullet
            existing_bullets.append('• ' + text)

# Add new note as bullet
if new_note:
    if not new_note.startswith('•'):
        new_note = '• ' + new_note
    existing_bullets.append(new_note)

# Clear all paragraphs
for para in cell.paragraphs:
    p = para._element
    p.getparent().remove(p)

# Rebuild cell content
# Add preserved text first if exists
if preserved_text:
    p = cell.add_paragraph()
    p.add_run(preserved_text)
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE

# Add each bullet as separate paragraph
for bullet in existing_bullets:
    p = cell.add_paragraph()
    p.add_run(bullet)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE

doc.save(doc_path)
print('SUCCESS')
`;
  
  const scriptPath = '/tmp/append_note.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  try {
    const cmd = `python3 ${scriptPath} "${docPath}" ${projectConfig.notes_table_index} ${projectConfig.notes_row_index} ${projectConfig.notes_cell_index} '${escapedNote}' '${preserved}'`;
    const { stdout, stderr } = await execAsync(cmd);
    
    if (!stdout.includes('SUCCESS')) {
      throw new Error(`Python script failed: ${stderr}`);
    }
    return true;
  } catch (error) {
    throw new Error(`Failed to append note: ${error.message}`);
  }
}

/**
 * Add a single note to today's report for a project
 * Called by imessage-watcher.js
 */
async function addNote(projectKey, noteText) {
  const config = loadConfig();
  const projectConfig = config.projects[projectKey];
  
  if (!projectConfig) {
    throw new Error(`Unknown project: ${projectKey}`);
  }
  
  // Find or create today's report
  const drInfo = await findTodaysDR(projectConfig);
  
  let docPath = drInfo.filepath;
  
  // If doesn't exist, create from most recent DR as template
  if (!drInfo.exists) {
    const projectPath = path.join(DOCS_PATH, projectConfig.folder);
    const files = await fs.readdir(projectPath);
    const drFiles = files
      .filter(f => f.startsWith('DR_') && f.endsWith('.docx') && !f.includes('.backup'))
      .sort()
      .reverse();
    
    if (drFiles.length === 0) {
      throw new Error(`No template found in ${projectPath}. Please add a DR template.`);
    }
    
    const templatePath = path.join(projectPath, drFiles[0]);
    await fs.copyFile(templatePath, docPath);
    
    // Update dates on new report
    await updateDates(docPath, projectConfig);
    
    // Clear old notes (will be replaced by first note)
    await clearNotesForNewReport(docPath, projectConfig);
    
    console.log(`Created new report: ${drInfo.filename}`);
  }
  
  // Append the note
  await appendNoteToDoc(docPath, projectConfig, noteText);
  
  return {
    filepath: docPath,
    filename: drInfo.filename,
    isNew: !drInfo.exists
  };
}

/**
 * Main function to update daily report
 */
async function updateDailyReport(projectConfig, notes, photos = []) {
  // Find or create today's DR
  const drInfo = await findTodaysDR(projectConfig);
  
  let docPath = drInfo.filepath;
  
  // If doesn't exist, need to create from template
  if (!drInfo.exists) {
    // Find most recent DR to use as template
    const projectPath = path.join(DOCS_PATH, projectConfig.folder);
    const files = await fs.readdir(projectPath);
    const drFiles = files
      .filter(f => f.startsWith('DR_') && f.endsWith('.docx') && !f.includes('.backup'))
      .sort()
      .reverse();
    
    if (drFiles.length === 0) {
      throw new Error(`No template found in ${projectPath}. Please add a DR template.`);
    }
    
    const templatePath = path.join(projectPath, drFiles[0]);
    await fs.copyFile(templatePath, docPath);
  } else {
    // Create backup of existing file
    await createBackup(docPath);
  }
  
  // Update document
  await updateDates(docPath, projectConfig);
  await updateNotes(docPath, projectConfig, notes);
  
  if (photos.length > 0) {
    await addPhotos(docPath, photos);
  }
  
  return {
    filepath: docPath,
    filename: drInfo.filename
  };
}

module.exports = {
  updateDailyReport,
  addNote,
  findTodaysDR
};
