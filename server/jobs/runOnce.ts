import { runDailyJobSearch } from './jobMatchService';
runDailyJobSearch(true)
  .then((r) => { console.log('RESULT', JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('FAILED', e); process.exit(1); });
