import fs from 'node:fs'
const dir = process.argv[2]
const load = f => JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'))
const inB = load('in-budget.json'), over = load('over-budget.json'), npmRt = load('npm-runtime.json')
const ms = v => v === null || v === undefined ? '-' : Number(v).toFixed(1)
const cov = a => a.coverage
const out = []
out.push('# Real-corpus calls — evidence 2026-10-30')
out.push('')
out.push('Machine: ' + inB.machine.platform + ' ' + inB.machine.arch + ', Node ' + inB.machine.node + ', ' + inB.machine.cpus + ' CPUs, ' + inB.machine.memGiB + ' GiB.')
out.push('')
out.push('OPS build: ' + inB.arms.candidate.version + ', lib sha256 ' + inB.arms.candidate.libSha256.slice(0, 12) + ', worker sha256 ' + inB.arms.candidate.worker.sha256.slice(0, 12) + '. Official arm: dsh-tool-fs ' + inB.arms.official.packages['dsh-tool-fs'] + ', dsh-tool-fs-search ' + inB.arms.official.packages['dsh-tool-fs-search'] + '.')
out.push('')
out.push('Runs: in-budget warmup 2 / repeat 5; over-budget warmup 1 / repeat 3; npm-runtime warmup 1 / repeat 3.')
out.push('')
out.push('Exit codes: in-budget 0, over-budget 0, npm-runtime 1 (one case exceeded the 30 s call cap; see 3).')
out.push('')
const table = (r, corpus, note) => {
  out.push('### ' + corpus.id + ' (' + corpus.class + ', ' + corpus.shape.files + ' files / ' + corpus.shape.mebibytes + ' MiB, pin ' + (corpus.pin ? corpus.pin.kind + '@' + corpus.pin.version : 'none (live directory)') + ')')
  out.push('')
  out.push('| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |')
  out.push('| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |')
  for (const k of corpus.cases) {
    const c = cov(k.candidate)
    out.push('| ' + k.id + ' | ' + ms(k.official.medianMs) + ' | ' + ms(k.candidate.medianMs) + ' | ' +
      (c ? c.scannedFiles : '-') + ' | ' + (c ? c.scanComplete : '-') + ' | ' + (c ? String(c.truncatedBy) : '-') + ' | ' +
      (c ? String(c.matchedObserved) + '/' + String(c.matchedTotal) : '-') + ' | ' + (c ? String(c.displayedItems ?? '-') : '-') + ' | ' +
      k.official.errors + '/' + k.candidate.errors + ' |')
  }
  out.push('')
  if (note) { out.push(note); out.push('') }
}
out.push('## 1. In-budget corpora — the #384 question')
out.push('')
out.push('The exact scans complete inside the budget (the matched total is known), so the exact/bounded ratio describes doing less work, not a faster algorithm. The earlier evidence round verified identical path/line/text prefixes for these same four queries over the same pins; this round does not repeat that check. Matched totals: 3,712 and 8,621.')
out.push('')
for (const c of inB.corpora) table(inB, c)
out.push('## 2. Over-budget corpora — coverage, not speed')
out.push('')
out.push('Every call completes, and every candidate scan stops at the 10,000-file / 256 MiB budget: the matched total is unknown, so these rows say what the budget does and how long it takes to reach it. They are not a speed comparison.')
out.push('')
for (const c of over.corpora) table(over, c)
out.push('## 3. npm-runtime — the 30 s wall')
out.push('')
out.push('The seven filtered cases complete. The unfiltered no-hit scan runs into the 30 s call cap: one round finished near 20 s and two were killed, so the runner reports RESULT_UNKNOWN and exits 1. That row is the finding, not a timing.')
out.push('')
for (const c of npmRt.corpora) table(npmRt, c)
out.push('## Caveats')
out.push('')
out.push('- Warmup was not enough for every series: the runs warned that glob-name/glob-miss/glob-html and some candidate series were still falling. All samples are kept; none were dropped to get a better number.')
out.push('- Dispatch-to-result time includes the tool bridge and the child process; it is not model-task time and not portable across machines.')
out.push('- Official grep has no per-call limit or exactTotal, and its sort/exclusion rules differ; the official column is a reference, not proof of equal work.')
out.push('- Real timing runs stay manual evidence. CI asserts behaviour, never a duration.')
out.push('')
fs.writeFileSync(dir + '/SUMMARY.md', out.join('\n'))
console.log('wrote ' + dir + '/SUMMARY.md (' + out.length + ' lines)')