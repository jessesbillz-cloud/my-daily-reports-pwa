const { generatePeriodSummary, formatSummaryForDSA155, fillDSA155 } = require('./dsa155-summarizer.js');
const config = require('./config.json');

const start = new Date(2026, 0, 16);
const end = new Date(2026, 0, 31);
const formDate = new Date(2026, 0, 31);

generatePeriodSummary('woodland park', config.projects['woodland park'], start, end)
  .then(async result => {
    console.log('Generating summary...');
    const summary = await formatSummaryForDSA155(result.grouped, 'woodland park');
    console.log('Summary:', summary);
    console.log('Filling PDF...');
    const pdf = await fillDSA155('woodland park', summary, start, end, formDate);
    console.log('Created:', pdf.filename);
  })
  .catch(err => console.error('Error:', err));
