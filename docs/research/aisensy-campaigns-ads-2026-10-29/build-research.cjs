// Local research packaging only. Does not execute target code or contact services.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=__dirname;
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,'');
const write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2));
const groups=[
['Campaign overview','campaigns-overview','observed UI','Quality rating|Messaging tier and quota|Campaign name search|Refresh campaign list|All/Broadcast/API/Agent tabs|Scheduled Pro tab|Campaign/type/date/status/audience table|Pagination and empty state|AI Agent shortcut|AI template shortcut|Status and lead-form ad shortcuts'],
['Campaign launch','campaign-types','observed UI','Campaign Agent mode|Broadcast existing audience|API template campaign|CSV broadcast|Meta Ads entry'],
['Broadcast','broadcast-details','observed UI; later steps blocked','Campaign name|Audience selection|Audience contact preview|Details/message/test-preview stepper|Next prerequisite gate'],
['Audience filters','broadcast-filter-types','observed UI','Search filter fields|Tags|Created Date|Last Seen|Opted In|Blocked|Segments|Lists|Name and mobile|Source and first message|Campaign membership|Intervened/closed/requested|Intervening agent|Lead stage|MAU status|WhatsApp conversation status|Dynamic custom attributes'],
['Audience filters','broadcast-filter-builder','observed UI','Default opt-in inclusion|Default blocked exclusion|AND conditions|Filter groups|Save as Segment action|Incomplete-condition validation|Apply and discard filters'],
['Audience filters','broadcast-tags-operators','observed UI','Tag has/not-has operators'],
['API campaign','campaign-api','observed UI; no approved templates available','Name and approved-template search|Set Live prerequisite gate'],
['CSV campaign','campaign-csv-upload','observed UI; no file uploaded','Name/upload/message/preview steps|Drop or select CSV|Previous/Next navigation|Upload prerequisite gate'],
['Campaign Agent','campaign-agent-goal','observed UI; generation not run','Agent name|Natural language goal|Available WCC display|Four-stage navigation|Save and exit action|Ctrl+Enter hint|Example goal prompts|Name prerequisite'],
['Campaign reporting','campaign-download-report','observed UI; not generated','Premium combined analytics CSV|From/To date fields'],
['Campaign reporting','campaign-user-report','observed UI; not generated','Premium per-user email report'],
['Campaign reporting','campaign-overview-report','observed UI; not generated','Consolidated CSV ZIP emailed report'],
['Campaign plans','campaign-schedule-plan-gate','advertised/gated; not executed','Scheduled campaign upgrade gate|Campaign click tracking|Campaign budget and analytics|CSV campaign scheduler|Automatic failed-message retry|Template TTL|Duplicate CSV contacts messaging'],
['Ads dashboard','ads-overview','observed UI; empty rows','Credit balance|Create Ad|AI Assistant|AiSensy and Fetched tabs|Ad name search|Sync insights action|Report download action|Metric summary cards|Actions/name/start/status/type/budget columns|Metric table columns|25-row default pagination|Loading and empty states'],
['Ads filters','ads-status','observed UI','Searchable status multi-selection|All/Active/Paused/Draft statuses'],
['Ads filters','ads-date-presets','observed UI','Today/Yesterday presets|7/30/90 day presets|Maximum history|Day wise selection|Custom range calendar|Month navigation|Unavailable future dates'],
['Ads metrics','ads-metrics','observed UI; six-count discrepancy documented','Six-metric chooser|Metric checkbox limits|Metric Cancel/Apply'],
['Ads columns','ads-columns','observed UI; no preferences saved','Column search|Expandable metric groups|Key metrics|Results breakdown|Actions breakdown|Video breakdown|Selected-column count|Drag-reorder selected columns|Remove selected column|Save as preset action|Cancel/Apply columns'],
['Fetched ads','ads-fetched','observed UI; no import run','Ad account selector|Account and insight sync|Fetch CTWA ads from Meta|Account-dependent disabled fetch'],
['AI ads','ads-agent','observed UI; no generation run','Business/URL/audience prompt slots|Shopify product selection action|Add media action|Image/video creative switch|Image quantity controls|Free-generation counter|Generate Ad action|Ad-type history tabs'],
['AI ads','ai-ad-types','observed UI','Automatic ad type|Click-to-WhatsApp generation|Website-to-WhatsApp generation|Website generation|Status generation'],
['AI ads','ai-aspect-ratios','observed UI','Portrait aspect ratios|Landscape/square ratios|Pixel dimension display'],
['AI ads','ai-video-options','observed UI; no credits spent','30/45/60-second video durations|Ad-credit cost display'],
['Ad destination','ad-create','observed UI','Five destination cards|WhatsApp verification gate|Five-step CTWA setup|Publish action|Sponsored ad preview'],
['Ad objectives','ad-objectives','observed UI; destination-dependent','Traffic objective|Engagement objective|Sales objective'],
['Ad goals','ad-performance-goals','observed UI; Traffic state','Link-click goal|Daily unique reach goal|Conversation goal|Impression goal'],
['Website ad','ad-website-objective','observed UI','Sales/conversions default|Pixel selector|Create Pixel shortcut'],
['Lead-form ad','ad-leadform-objective','observed UI','Fixed Leads objective|Maximize leads goal'],
['Ad targeting','ad-targeting','observed UI','Saved audiences|Multiple custom/lookalike audiences|Create audience shortcut|Exclude audiences|Include/exclude locations|Gender selector|Minimum/maximum ages|Instagram placements|Facebook placements|Platform enable/clear-all|Interests/demographics/behaviors|Meta audience expansion|Save Audience action'],
['Ad budget','ad-budget','observed UI','Daily/lifetime modes|Budget amount input|Start date|Optional end date|Budget summary'],
['Ad budget','ad-schedule-gate','observed gate; grid behavior unverified','Weekly time-block schedule|Lifetime-only schedule restriction'],
['Ad creative','ad-creative-image','observed UI','Ad name 255 counter|Primary text 2200 counter|Headline 40 counter|Description 30 counter|Image/video/carousel switch|Media URL|Media Library action|AI creative prompt|Product image selector|Brand logo selector|Aspect ratio selector|Audience selector|CTA selector|Generation history action|Missing-input Generate gate'],
['Carousel','ad-carousel','observed UI','Two initial cards and ten-card counter|Drag reorder|Add images/videos|Generate images action|Expand/collapse card|Remove card|Card media URL|Per-card headline/description|Apply headline to all cards|Multiple-card preview'],
['Website creative','ad-website-creative','observed UI','Destination URL|CTA selection|Website preview label'],
['Lead-form creative','ad-leadform-creative','observed UI; form creation disabled','Select/create lead form|Lead form CTA|Estimated daily reach/impressions/leads'],
['Icebreakers','ad-icebreakers','observed UI; none saved','Saved icebreaker search|Create new icebreaker|Icebreaker name|Greeting message|80-character message counter|Flow selector|Choose flow block|Add another icebreaker|Save icebreakers action|WhatsApp chat preview|Prefilled customer-message explanation'],
['Leads','ads-leads','observed UI; no leads','Total/form/CTWA counters|Name/email/phone search|Form filter|Ad filter|Date filter|All/Form/CTWA tabs|Selected-lead Broadcast|CSV export|Sync missed leads|Selection/empty-state gates'],
['Forms','ads-forms','observed UI; no forms','Form status/response counters|Search forms|Sync forms|Empty form state'],
['Forms','ads-form-sort','observed UI','Newest/oldest sorting|Most/fewest leads sorting'],
['Forms','ads-form-automation-filter','observed UI','Automation All/On/Off filter'],
['Audiences','ads-audiences','observed UI; no saved audiences','AiSensy/Fetched tabs|All/Website/Custom/Lookalike filters|Audience name search|Audience sync|Audience pagination'],
['Custom audience','audience-create-custom','observed UI','Name 50 counter|Description 100 counter|Customer CSV source|Website/pixel source|Database-contact source|Required-name gate'],
['Website audience','audience-pixel-rules','observed UI; pixel unavailable','Criteria combiner|Pixel data source|Event selector|Retention days|Narrow Further|Exclude people|Missing-pixel validation'],
['Lookalike audience','audience-lookalike','observed UI','Source audience selector|Size slider|1/2/5/10-percent presets|Similarity/reach explanations|Creation prerequisite gate'],
['Events','ads-events','observed UI; no events','Event-name search|Sync pixels|Create Event entry|Empty event state'],
['Events','ads-create-event','observed UI; no event created','Name 100 counter|Description 1024 counter|Cancel/create and required-input gate'],
['Setup','ads-setup','observed UI; no account changes','Facebook connection state|Disconnect action|Facebook page selection|Create Page action|Page sync|Lead-form terms link and acceptance gate|WhatsApp number linking|Verification action|Create-ad prerequisite gate|Setup tutorial/demo links'],
['Credits','ads-credit-dialog','observed UI; no purchase','Credit amount input|Minimum 1500 displayed|Quick-add amounts|Purchase Now action|Credit usage explanation'],
];
const features=[];
for(const [area,source,status,list] of groups) for(const title of list.split('|')) features.push({id:`CAP-${String(features.length+1).padStart(3,'0')}`,area,title,evidence:`evidence/${source}.txt`,status});
const staticEntries=[
['Campaign state','86983.js:59','Paginated campaign list contract and name/tab filters'],
['Campaign state','55940.js:30','Fetch campaigns and daily quota'],
['Ad generation','14876.js:34','Image/video generation payload fields'],
['Lead data','22877.js:351','Contact filters, answers, timezone and pagination'],
['Lead data','22877.js:389','Per-contact submission history'],
['Form data','22877.js:399','Form status, automation, sorting and detail queries'],
['Lead exports','22877.js:474','Selected/all-minus-exclusions CSV export'],
['Lead exports','22877.js:500','Form-response export with answer filters'],
['Ad lifecycle','22877.js:531','Ad status update request'],
['Audience backend','91506.js:157','Async custom audience validation and payload'],
['Audience backend','91506.js:224','Lookalike source/spec payload'],
['Audience backend','91506.js:257','Combined custom and lookalike creation'],
['Pixel data','91506.js:528','Pixel list, detail, stats, sync and create call sites'],
['Flow routing','81766.js:30','Icebreaker flow/block/handle state fields']];
for(const [area,source,title] of staticEntries)features.push({id:`CAP-${String(features.length+1).padStart(3,'0')}`,area,title,evidence:`static-modules/${source}`,status:'static code only; backend unverified'});
write('feature-catalog.json',features);
fs.writeFileSync(path.join(root,'feature-catalog.csv'),'\uFEFF'+['id,area,title,evidence,status',...features.map(r=>Object.values(r).map(x=>'"'+String(x).replaceAll('"','""')+'"').join(','))].join('\r\n'));
const ui=[];
for(const file of fs.readdirSync(path.join(root,'evidence')).filter(x=>x.endsWith('.txt'))){
 const lines=read('evidence/'+file).split(/\r?\n/);
 lines.forEach((text,i)=>{if(text.trim())ui.push({source:'evidence/'+file,line:i+1,text:text.trim()});});
}
write('ui-elements.json',ui);
const endpoints=[];
for(const file of fs.readdirSync(path.join(root,'static-modules')).filter(x=>x.endsWith('.js'))){read('static-modules/'+file).split(/\r?\n/).forEach((line,i)=>{for(const m of line.matchAll(/"(\/(?:meta|ad-templates|campaign|api|payment)[^"\s]*)"/g))endpoints.push({pathFragment:m[1],source:'static-modules/'+file,line:i+1,context:line.trim(),status:'static path candidate; not a network observation'});});}
write('endpoint-candidates.json',endpoints);
const rea=JSON.parse(read('rea-static-modules.json'));
write('rea-summary.json',{evidence_id:rea.evidence_id,operation:rea.operation,parameters:rea.parameters,limitations:rea.limitations,statistics:rea.normalized_result?.statistics,graphCoverage:rea.normalized_result?.graph?.coverage,semanticCoverage:rea.normalized_result?.semantic_graph?.coverage});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cards=features.map(f=>`<article data-search="${esc(Object.values(f).join(' ').toLowerCase())}"><small>${esc(f.id)} · ${esc(f.area)}</small><h3>${esc(f.title)}</h3><p>${esc(f.status)}</p><a href="${esc(f.evidence.replace(/:\d+$/,''))}">Evidence ${esc(f.evidence)}</a></article>`).join('');
const screenshots=fs.readdirSync(path.join(root,'evidence')).filter(x=>/\.(png|jpg)$/.test(x));
fs.writeFileSync(path.join(root,'catalog.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AiSensy Campaigns & Ads — Research Catalog</title><style>body{font:16px system-ui;margin:0;background:#f2f5f5;color:#123b40}header,main{max-width:1200px;margin:auto;padding:28px}header{background:#fff}h1{font-size:32px}a{color:#006b61}input{box-sizing:border-box;width:100%;padding:16px;font:inherit;border:1px solid #b9cecc;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}article{background:white;border:1px solid #d9e3e2;border-radius:9px;padding:18px}h3{margin:8px 0;font-size:18px}small,p{color:#4d6264}img{max-width:100%;border:1px solid #ccd}figure{margin:24px 0;background:white;padding:16px}summary{cursor:pointer;padding:12px;background:#deeeea}[hidden]{display:none!important}</style><header><h1>Campaigns & Ads Manager</h1><p>Extracted research · observed 29 Oct 2026 · packaged 30 Oct 2026. No replica implemented.</p><p>${features.length} capability records. Partial coverage: empty account data, plan gates, missing approved templates and untested backend behavior.</p><nav><a href="README.md">Detailed breakdown</a> · <a href="feature-catalog.csv">CSV</a> · <a href="ui-elements.json">UI inventory</a> · <a href="endpoint-candidates.json">Static endpoints</a> · <a href="rea-summary.json">REA summary</a></nav></header><main><label for="q">Search capabilities</label><input id="q" placeholder="Try carousel, audience, report, preview, pixel…"><p id="count">${features.length} records</p><section class="grid">${cards}</section><h2>Actual captured screens</h2><p>Original screenshots, not reconstructed previews. Full conditional state coverage is not established.</p>${screenshots.map(f=>`<details><summary>${esc(f)}</summary><figure><img loading="lazy" src="evidence/${esc(f)}" alt="${esc(f)}"><figcaption>${esc(f)}</figcaption></figure></details>`).join('')}<h2>Evidence snapshots</h2><ul>${fs.readdirSync(path.join(root,'evidence')).filter(x=>x.endsWith('.txt')).map(f=>`<li><a href="evidence/${esc(f)}">${esc(f)}</a></li>`).join('')}</ul></main><script>const q=document.getElementById('q'),cards=[...document.querySelectorAll('article')];q.addEventListener('input',()=>{let n=0;for(const c of cards){c.hidden=!c.dataset.search.includes(q.value.toLowerCase());if(!c.hidden)n++;}document.getElementById('count').textContent=n+' records';});</script></html>`);
const manifest=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory())walk(p);else if(!['evidence-manifest.json','extraction.zip'].includes(ent.name)){const b=fs.readFileSync(p);manifest.push({path:path.relative(root,p).replaceAll('\\','/'),bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});}}}
walk(root);write('evidence-manifest.json',{captured:'2026-10-29',packaged:'2026-10-30',features:features.length,uiOccurrences:ui.length,endpointCandidates:endpoints.length,files:manifest});
for(const f of features)if(!fs.existsSync(path.join(root,f.evidence.replace(/:\d+$/,''))))throw Error('Missing evidence '+f.evidence);
console.log(JSON.stringify({features:features.length,uiOccurrences:ui.length,endpointCandidates:endpoints.length,screenshots:screenshots.length,files:manifest.length}));
