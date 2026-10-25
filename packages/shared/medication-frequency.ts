/** Display only: never rewrite the prescription or infer a frequency from free text. */
export function formatMedicationFrequency(value:unknown):string {
 const raw=String(value??'');
 if(!raw||/[\u3400-\u9fff]/.test(raw))return raw;
 const key=raw.trim().toLowerCase().replace(/\./g,'');
 const labels:Record<string,string>={qd:'每日一次',bid:'每日两次',tid:'每日三次',qid:'每日四次',qn:'每晚一次',qod:'隔日一次',qw:'每周一次',prn:'必要时'};
 const hourly=/^q([1-9]|1\d|2[0-4])h$/.exec(key);
 const label=labels[key]||(hourly?`每${Number(hourly[1])}小时一次`:'');
 return label?`${raw}（${label}）`:raw;
}
