import fs from 'node:fs'
const reports = process.argv.slice(2)
for (const file of reports) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`\n${file}: warmup=${report.warmup}, repeat=${report.repeat}`)
  for (const corpus of report.corpora) {
    console.log(`\n${corpus.id}: files=${corpus.shape.files}, MiB=${corpus.shape.mebibytes}, changed=${corpus.inputChanged}`)
    console.log('|case|official median ms|OPS median ms [min,max]|errors official/OPS|OPS scan|observed/total/displayed|')
    console.log('|---|---:|---:|---:|---:|---|')
    for (const item of corpus.cases) {
      const arm=item.candidate, coverage=arm.coverage
      const values=corpus.rows.filter(row=>row.case===item.id&&row.projection==='candidate'&&!row.isError).map(row=>row.durationMs)
      console.log(`|${item.id}|${item.official?.medianMs}|${arm.medianMs} [${values.length?Math.min(...values).toFixed(1):'-'}, ${values.length?Math.max(...values).toFixed(1):'-'}]|${item.official?.errors}/${arm.errors}|${coverage?.scannedFiles} ${coverage?.scanComplete?'complete':coverage?.truncatedBy??'gap'}|${coverage?.matchedObserved}/${coverage?.matchedTotal}/${coverage?.displayedItems}|`)
    }
    for(const limit of [5,50]) {
      const exact=corpus.cases.find(item=>item.id===`grep-hit-${limit}-exact`).candidate
      const bounded=corpus.cases.find(item=>item.id===`grep-hit-${limit}-bounded`).candidate
      console.log(`limit ${limit}: median ratio ${exact.medianMs/bounded.medianMs}, reduction ${100*(1-bounded.medianMs/exact.medianMs)}%`)
    }
  }
}
