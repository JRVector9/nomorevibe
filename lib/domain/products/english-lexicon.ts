/**
 * Common English and software/product words (base forms) used as POSITIVE evidence that a short Latin-script product
 * text is English. Result validation only (translation-english.ts) — not a display or source-readiness detector.
 *
 * Deliberately excluded: forms that are frequent function words of other Latin-script languages (de, la, le, el, en,
 * et, die, con, per, pro, para, van, met, son, sin, tu, te, mi, ma, un, una, des, les, il, di, je, na, se, ve, dan,
 * yang, sa, ng, mga). Inflections (-s, -es, -ies, -ed, -ing, -er, -ers, -est, -ly) are derived by englishWord().
 */
const FUNCTION_WORDS = `a an the this that these those there here what which who whom whose when where why how all any both each every
few many much more most other others some such no nor not only own same so than too very can cannot can't will won't just should
shouldn't now and or but if because as until while of at by for with about against between into through during before after
above below to from up down in out on off over under again further then once also yet still even ever never always often
already almost around across along among behind beyond near within without upon via i me my mine myself we us our ours
ourselves you your yours yourself yourselves he him his himself she her hers herself it its it's itself they them their theirs
themselves is are was were be been being have has had having does did doing done would could might must shall may get got
gotten let one two three four five six seven eight nine ten twenty hundred thousand million billion first second third next
last another anything everything nothing something anyone everyone someone nobody anybody everybody whatever whether though
although unless since instead else etc i'm i've i'd i'll you're you've you'll we're we've we'll they're they've isn't aren't
don't doesn't didn't wasn't weren't hasn't haven't couldn't wouldn't let's that's what's there's here's who's yes ok okay
less least enough quite rather really maybe perhaps whose onto into toward towards versus vs whenever wherever`;

const COMMON_WORDS = `able about absolute accept access accident account accurate achieve acid across act action active activity actual
add address adjust admin administer admit adopt adult advance advanced advantage adventure advice advise affect afford afraid
age agency agent ago agree ahead aid aim air alarm album alert alien align alive allow alone alpha alternative amazing amount
analysis analyze analyse anchor ancient angle angry animal animate announce annual answer anticipate anywhere apart apartment
appeal appear apple apply appoint approach approve approximate area argue argument arm army arrange array arrival arrive art
article artist aside ask aspect assemble assess asset assign assist assistant associate assume assure attach attack attempt
attend attention attract audience audio author authority auto automate automatic automation autonomous available average avoid
award aware away awesome baby back background bad bag balance ball ban band bank bar base basic basis basket bat batch battle
beach bear beat beautiful beauty become bed bee beer begin beginner behavior behaviour behave belief believe bell belong below
belt bench benefit best bet better beyond bias big bike bill bind bird birth birthday bit bite black blank blend bless blind
block blog blood blow blue board boat body bold bone bonus book boost boot border boring born borrow boss bother bottle bottom
bounce bound box boy brain branch brand brave bread break breakfast breath breathe brick bridge brief bright brilliant bring
broad broadcast broken brother brown brush buck bucket budget bug build building built bulk bunch burn burst bus business busy
butter button buy buyer cabin cable cake calculate calculation calculator calendar call calm camera camp campaign campus can
cancel cancer candidate cap capable capacity capital capture car carbon card care career careful cargo carry cart case cash
cast casual cat catalog catalogue catch category cause cell center centre central century certain certificate chain chair
challenge champion chance change channel chapter character charge chart chat cheap check cheese chef chemical chemistry chest
chicken chief child childhood choice choose chronic church circle citizen city civil claim class classic classroom clean
clear clever click client climate climb clinic clock clone close cloth cloud club clue coach coal coast coat code coffee coin
cold collaborate collapse collect collection college color colour column combat combine  comfort comfortable comic command
comment commercial commit common communicate community company compare compete competition competitive compile complain
complete complex component compose composition compound comprehensive compute computer concept concern concert conclusion
condition conduct conference confidence confident confirm conflict confuse connect connection conscious consider consistent
constant construct consult consumer contact contain container content contest context continue contract contrast contribute
control convenient conversation convert cook cookie cool cooperate copy core corner corporate correct cost cottage cotton
could council count counter country county couple courage course court cousin cover cow craft crash crazy cream create creative
creator credit crew crime crisis critical crop cross crowd crucial cruise cry crypto culture cup cure curious currency current
curve custom customer customize cut cute cycle daily damage dance danger dangerous dark dashboard data database date daughter
day dead deal dear death debate debt decade decide decision deck declare decline decorate deep defeat defend defense defence
define definite degree delay delete deliver delivery demand demo democracy demonstrate dense deny department depend deploy
deposit depth describe description desert design designer desire desk desktop despite destination destroy detail detect
determine develop developer development device devote diagram dialog dialogue diary dictionary  diet differ difference
different difficult dig digital dinner direct direction director dirty disable disagree disappear discount discover discovery
discuss discussion disease dish disk display distance distinct distribute district dive divide division doctor document dog
dollar domain domestic dominate door dose double doubt download dozen draft drag drama draw dream dress drink drive driver
drop drug dry duck due dump duty dynamic eager ear early earn earth ease easy eat economic economy edge edit edition editor
educate education effect effective efficient effort egg either elect election electric electricity electronic element elevate
eliminate else email embed emergency emotion emphasis employ employee empty enable encounter encourage end enemy energy engage
engine engineer engineering enhance enjoy enormous ensure enter enterprise entertain entire entry environment episode equal
equipment equivalent era error escape especially essay essential establish estate estimate event eventually evidence evil
evolve exact exam examine example excellent except exchange excite exciting exclusive excuse execute exercise exhibit exist
exit expand expect expense expensive experience experiment expert explain explore export expose express extend extension
extra extract extreme eye face facility fact factor factory fail failure fair faith fall false fame familiar family famous
fan fancy fantastic fantasy far farm farmer fashion fast fat father fault favor favour favorite favourite fear feature fee feed
feedback feel fellow female fence festival fetch fever few field fight figure file fill film filter final finance financial
find fine finger finish fire firm fish fit fix flag flash flat flavor flavour flee flexible flight float flood floor flow
flower fly focus fold folder folk follow food fool foot football force forecast foreign forest forever forget forgive fork form
formal format former formula fortune forum forward found foundation frame framework free freedom freeze frequent fresh friend
friendly frog front fruit fuel full fun function fund funny furniture future gain gallery game gang gap garage garden gas gate
gather gear general generate generation generator generous gentle genuine gesture ghost giant gift girl give glad glass global
glory glove glow go goal god gold golf good goods govern government grab grade gradual graduate grain grand grant graph graphic
grass grateful gray great green grey grid grocery ground group grow growth guarantee guard guess guest guide guild guilty
guitar gun guy gym habit hack hair half hall hand handle hang happen happy hard hardware harm  hate head health healthy hear
heart heat heavy height hello help helpful hero hide high highlight hill hint hire history hit hobby hold hole holiday home
homework honest honey hope horse hospital host hot hotel hour house household huge human humor humour hungry hunt hurry hurt
husband ice icon idea ideal identify identity ignore ill image imagine immediate impact implement import important impose
impossible impress improve inch include income increase incredible independent index indicate individual industry infinite
influence inform information initial injury inner innocent input insert inside insight inspect inspire install instance instant
institute instruction instrument insurance integrate intelligence intelligent intend intense interact interest interesting
interface internal international internet interpret interval interview introduce invent invest investigate investment invite
involve iron island issue item jacket job join joint joke journal journey joy judge juice jump junior jury just justice keep key
keyboard kick kid kill kind king kitchen knee knife knock know knowledge lab label labor labour lack lady lake lamp land landing
language large laser late later laugh launch law lawyer lay layer layout lazy lead leader leaf league lean learn learning lease
leave lecture left leg legal legend lemon lend length lesson letter level library license licence lie life lift light like
limit line link lion lip liquid list listen literature little live load loan local locate location lock log logic logo
lonely long look loop loose lose loss lost lot loud love lovely low luck lucky lunch machine mad magazine magic mail main
maintain major male mall manage management manager manual manufacture map margin mark market marriage marry mass master
match mate material math maths matter maximum meal mean measure meat media medical medicine medium meet meeting member memory
mental mention menu merchant mere merge mess message metal method middle midnight might mild mile military milk mind minimum
minister minor minute mirror miss mission mistake mix mobile mode model modern modest modify module moment money monitor month
mood moon moral morning mother motion motor mount mountain mouse mouth move movement movie much multiple murder muscle museum
music musical must mystery myth nail name narrow nation national native natural nature navigate near nearby neat necessary neck
need negative neighbor neighbour neither nerve nervous net network neutral never nice night noble node noise none normal north
nose note notice notion novel number numerous nurse nut object observe obtain obvious occasion occupy occur ocean odd offer
office officer official oil old open opening operate operation operator opinion opponent opportunity oppose option orange
order ordinary organ organic organization organisation organize organise origin original otherwise ought outcome outdoor
outer output outside oven overall overcome overview owe owner pace pack package page pain paint painting pair palace pan panel
paper parent park parking part partner party pass passenger passion password past patch path patient pattern pause pay payment
peace peak pen penalty pencil people pepper percent perfect perform performance period permanent permission permit person
personal pet phase phone photo phrase physical piano pick picture piece pig pile pilot pin pink pipe pitch pixel pizza place
plain plan plane planet plant plastic plate platform play player pleasant please pleasure plenty plot plus pocket poem poet
point poison pole police policy polish polite political politics poll pool poor pop popular population port portable portal
portion portrait pose position positive possess possible post pot potato potential pound pour poverty powder power practical
practice practise praise pray precise predict prefer premium prepare presence present preserve president press pressure pretty
prevent preview previous price pride primary prime prince principal principle print prior priority prison privacy private
prize probably problem procedure proceed process produce product production profession professional professor profile profit
program programme progress project promise promote prompt proof proper property proposal propose prospect protect protection
protein protest proud prove provide provider public publish pull pump punch purchase pure purple purpose push put puzzle
qualify quality quantity quarter queen query question queue quick quiet quit quiz quote race radio rail rain raise random range
rank rapid rare rate raw reach react read reader ready real reality realize realise reason reasonable rebel recall receipt
receive recent recipe recognize recognise recommend record recover recovery red reduce refer reference reflect reform refresh
refuse regard region register regular reject relate relation relationship relative relax release relevant reliable relief
religion rely remain remark remember remind remote remove rent repair repeat replace reply report represent republic reputation
request require rescue research resident resist resolve resource respect respond response rest restaurant restore result
resume retail retain retire return reveal revenue reverse review revolution reward rhythm rice rich ride right ring rise risk
river road robot rock role roll roof room root rope rose rough round route routine row royal rule run rural rush sad safe
safety sail salad salary sale salt sample sand satisfy save saving say scale scan scenario scene schedule scheme scholar
school science score screen script sea search season seat secret section sector secure security see seed seek seem segment
select self sell send senior sense sensitive sentence separate sequence series serious serve service session set settle setup
severe sex shade shadow shake shall shape share sharp shave sheet shelf shell shift shine ship shirt shock shoe shoot shop short
shot shoulder shout show shower shut shy sick side sight sign signal significant silent silly silver similar simple simply
sing single sister sit site situation size skill skin sky sleep slide slight slim slip slow small smart smell smile smoke smooth
snack snake snap snow soap soccer social society sock soft software soil solar soldier solid solution solve song soon sorry
sort soul sound soup source south space spare speak special species specific speech speed spell spend spin spirit split sport
spot spread spring square stable staff stage stair stake stand standard star start state statement station status stay steady
steal steam steel step stick stock stomach stone stop storage store storm story straight strange stranger strategy stream street
strength stress stretch strict strike string strip stroke strong structure struggle student studio study stuff stupid style
subject submit subscribe substance succeed success successful sudden suffer sugar suggest suit summary summer sun super supply
support suppose sure surface surgery surprise surround survey survive suspect sustain swap sweet swim swing switch symbol system
table tackle tag tail take tale talent talk tall tank tap target task taste tax taxi tea teach teacher team tear tech technical
technique technology teen teenager telephone television tell temperature template temple temporary tend tennis tension term
terrible territory test text thank theater theatre theme theory therapy thick thin thing think thought thread threat throat
throw ticket tide tie tight time tiny tip tire tired title today toe together toilet token tomorrow tone tongue tonight tool
tooth top topic total touch tough tour tourist tower town toy trace track trade tradition traffic train training transaction
transfer transform transit translate transport trap travel treat treatment tree trend trial trick trip trouble truck true
trust truth try tube tune turn tutor twin twist type typical ugly ultimate unable uncle understand uniform union unique unit
universe university unknown unlock update upgrade upload upper upset urban urge urgent usage use useful user usual vacation valid
valley valuable value  variable variety various vary vast vehicle venture version video view village violence virtual virus
visible vision visit visitor visual vital voice volume vote wage wait wake walk wall wallet want war warm warn wash waste watch
water wave way weak wealth weapon wear weather web website wedding week weekend weekly weight weird welcome well west wet wheel
wide wife wild win wind window wine wing winner winter wire wise wish witness woman wonder wonderful wood word work worker
world worry worth wrap write writer writing wrong yard year yellow yesterday young youth zero zone
anniversary apology appetite architecture assignment attendance biology calorie carpool charity checklist checkout chore
coupon crossword daycare deadline diagnosis donation errand flashcard footprint fridge gardening grammar homepage horoscope
inbox inventory invoice itinerary journaling landlord laundry leaderboard lifestyle lottery mortgage neighborhood neighbourhood
nutrition parenting paycheck payroll pharmacy podcast poker postcard prescription quarterly questionnaire receipt reminder
renovation roommate scorecard scrapbook seating shopping sightseeing skincare sleepwear spreadsheet standings subscription
tenant timetable toolbox tournament tracker trivia tuition vocabulary voucher wardrobe warehouse wellness workout workshop
yoga ride rides rental booking housing healthcare hiring recruiting freelance freelancer startup startups wholesale ecommerce
marketplace crowdfunding fintech insurtech proptech edtech payroll accounting bookkeeping banking investing trading stocks
portfolio retirement savings expenses expense taxes spending budgeting allowance pension loan loans lender borrower
modern simple smart quick easy fast free open private secure tiny small lightweight minimal minimalist powerful beautiful
elegant clean friendly cozy chaotic fun funny cute clever honest real live instant offline online local remote global
interactive collaborative automatic automated intelligent experimental official unofficial personal professional public
popular classic retro vintage daily weekly monthly yearly annual nearest closest smarter faster easier better best worst
another everyday advanced basic complete full unified universal flexible scalable reliable robust stable durable portable
accessible affordable sustainable responsive realistic fully truly directly entirely completely currently simply easily
quickly safely privately locally automatically instantly finally actually basically definitely probably nearly mostly
`;

const SOFTWARE_WORDS = `ai api apis app apps js ts jsx tsx cpp ui ux sdk ide applet algorithm algorithms analytics android angular ansible apache archive archiver ascii asset
async audit auth authentication authorization autocomplete autopilot avatar backend backup bandwidth barcode benchmark beta
binary bitcoin blockchain bluetooth bookmark boilerplate bootstrap bot bots breakpoint browser buffer builder bundle bundler
byte bytes cache callback canvas captcha changelog chatbot checkpoint checksum chip cipher cli clipboard cluster cmd codebase
codec coder coding compiler config configuration configure console container cookie cpu crawler cron crud cryptography css
csv cursor daemon dapp dashboard dataset debug debugger decentralized decode decoder decrypt dependency deployment devops dex
diff directory discord dns docker docs documentation dom dotfile dotfiles download downloader driver dropdown ebook editor
emoji emulator emulation encode encoder encrypt encryption endpoint engine env ethereum event exporter extension faq favicon
feed fetcher figma filesystem firmware fork formatter frontend fullstack gateway gif git github gitlab glitch gpu graphql gui
hackathon hardware hash hashtag headless helm homelab hook hosting hotkey html http https hub ide importer inbox indexer
infra infrastructure installer integration iot ios java javascript jpeg jpg json jwt kanban kernel keybinding keychain
keyword kit kubernetes lambda laptop latency launcher layout library lint linter linux llm llms localhost login logger
logging logout lookup mac macos mailbox malware markdown markup mcp mesh metadata metric metrics microservice middleware
migration minecraft mint mockup mod mods modal modular mono monorepo multiplayer mvp mysql namespace navbar neural newsletter
nft node nodes notebook notification npm oauth offline onboarding openai opensource ops optimizer orm overlay parser
password patch payload pdf peer pipeline pixel playground playlist plugin plugins png podcast poll polyfill popup portfolio
postgres preprocessor prettier processor profiler prompt prototype provider proxy pwa python query queue quickstart rag
react readme realtime recorder redis refactor regex registry relay renderer repo repos repository resizer rest reverse rss
ruby runtime rust saas sandbox scanner scheduler schema scraper screenshot sdk seo serializer server serverless shader
shell shortcut shortener sidebar signup simulator sitemap slack slider smartphone snapshot snippet socket solver spam
spreadsheet sql sqlite ssh ssl stack starter storage streaming subscription svg swift syntax sync tablet tabletop tailwind
telegram telemetry template terminal testnet theme thumbnail timer timeline timestamp toggle toolchain toolkit tooltip
tracker trading transcript transpiler tutorial tweet twitter typescript typeface ui unicode uptime url usb utility utilities
ux validator vault vector viewer vim virtualization vpn vr vscode vue wallpaper wasm webapp webassembly webcam webhook webpage
webrtc websocket widget wiki wikipedia windows wireframe wordpress workflow workspace wrapper xml yaml youtube zip
agentic chatgpt claude copilot gemini gpt llama ollama openrouter anthropic huggingface transformer transformers embedding
embeddings finetune inference prompt prompts rerank tokenizer chess sudoku tetris wordle snake pomodoro todo habit habits
recipes quiz trivia flashcards journal notes notepad wiki forum blog vlog meme memes sticker stickers emoji gif gifs fitness
workout gym calorie calories macro nutrition meditation sleep mood diary planner kanban scrum agile sprint roadmap okr crm erp
cms lms hrm pos kpi seo saas paas iaas b2b b2c p2p dao defi nft web3 dapp token tokens wallet wallets exchange swap staking
mining validator rollup bridge oracle ledger escrow invoice invoicing billing checkout cart shop store storefront catalog
inventory shipping logistics delivery tracking booking reservation scheduling appointment calendar reminder alarm countdown
stopwatch clock weather forecast map maps navigation gps geolocation transit traffic parking ride rideshare carpool taxi
travel trip hotel flight airline airport ticket tickets event events concert festival venue restaurant menu recipe cooking
food grocery groceries delivery coffee cafe bar pub brewery wine beer cocktail pet pets dog dogs cat cats vet adoption
school student students teacher teachers class classes course courses lesson lessons tutor tutoring exam exams homework
grade grades campus university college library book books reading reader ebook audiobook podcast radio music song songs
playlist album artist band guitar piano drum karaoke lyrics beat beats dj mixer studio video videos film films movie movies
series tv streaming anime manga comic comics game games gaming gamer arcade puzzle puzzles rpg mmo fps roguelike roguelite
platformer simulator  sandbox multiplayer coop leaderboard tournament esports league team teams player players coach
soccer football basketball baseball tennis golf hockey cricket rugby volleyball running cycling hiking climbing skiing
surfing fishing hunting camping garden gardening plant plants farm farming
`;

const MORE_WORDS = `english spanish german french japanese chinese korean italian portuguese russian dutch danish swedish norwegian finnish
polish turkish greek arabic hebrew hindi indian american british european african asian australian canadian mexican brazilian
irish scottish latin nordic western eastern northern southern international multilingual bilingual
academic accessibility accountability accumulate acquisition activist adaptive addiction adjacent administrative adoption
advocacy aerial aesthetic affiliate aggregate aggregator agriculture aircraft airline algebra allergy allocation alumni ambient
amplifier analog analogue analyst anatomy annotation annotate anomaly anonymous antenna anxiety apparel appliance applicant
approval aquarium archaeology arena arithmetic armor arrow artificial artwork assembly assessment astronomy athlete atlas
atmosphere atom attachment attendee attorney auction augmented authentic autism availability backlog backpack bakery ballot
banner barber baseline battery beginner benchmark beverage bicycle bilingual biography biometric blender blogger blueprint
boilerplate booklet bookshelf botany boundary bracket brainstorm brewery brew broker browse buddy builder bundle bureau
butterfly cafeteria calibrate camper candle canvas capsule caption carbon cardio caregiver carousel cartoon casino catering
cemetery census ceremony certification chamber chapter charger charter checker cheat chemist childcare chord chorus cinema
circuit citation civic clarity classifier classify clinical clinician closet clothing coaching cognitive coin collector
colony combo comedy commerce commission commute companion compass compliance composer compost comprehension compression
concierge configurator conjugate conjugation consent conservation console consultant consultation contractor contributor
convention converter cookbook coordinate coordinator copywriting correction correlate cosmetic cosmic costume counsel
counselor coverage coworker craftsman crawl creature cricket crochet crossover crowdsource cuisine curate curator curriculum
cushion cyclist dairy dataset dating dealer debit decoration decorator deduplicate defender delegate deli dementia democrat
demographic dental dentist dependency deploy deputy dermatology descriptor designated detective diabetes diagnostic dialect
diet dietary digest dimension dine diner diploma disability disaster discipline disclosure disco discord dispatch dispatcher
dispute distiller distributor diversity diving dock doctor documentary donor dosage drawing dresser drill drone drummer
dungeon duplicate ebook ecology ecosystem editorial educator elderly electrician elevator embassy embroidery emergency
empire employer encyclopedia endurance enrollment enrolment entrepreneur entrepreneurship envelope epic equation equity
estimator ethic ethics ethical evaluate evaluation evaluator evolution exhibition expedition explainer explorer exposure
fabric facial factual fairy faculty fantasy fare fashion federal fertility fiber fibre fiction fighter filmmaker
fingerprint firefighter firework fishing fitness fixture flashcard fleet florist fluent folklore footage forensic forge
formation fossil foster fraction fragrance franchise fraud freight frontier fundraising funeral furniture galaxy gallery
gambling garment gaming gauge gear genealogy generic genetic genome geography geology geometry glossary glucose goalkeeper
gourmet governance graduation grammar graphics gratitude grief grill guardian guidebook gymnastics habitat hairdresser
handbook handmade handwriting harbor harbour harmony harvest hazard headline headphone headquarters healer hearing heritage
hiking hint historian historic historical hockey homeowner homeless honor honour hormone horror horticulture hospitality
hostel humanity hunter hurricane hybrid hydration hygiene illustrate illustration illustrator immigrant immigration immune
immersive inclusive incubator indie infant infection inflation influencer ingredient inheritance injection inmate innovate
innovation innovator inspection inspector inspiration instructor intake intern internship interpreter intervention intimate
introduction intuitive inventor inventory investor invitation irrigation isolation jazz jewel jewelry jewellery journalism
journalist karate keeper kindergarten knit knitting laboratory landmark landscape laptop lawn leadership learner leather
legacy legislation leisure lending lesson lever lexicon librarian lifeguard lifetime lighting linguistic literacy literary
livestock lodge logistic longevity loyalty lumber luxury lyric magnet mailing makeup mammal manuscript marathon marine
maritime marketer marketing mascot massage mathematics mattress maze mechanic mechanical mechanism medal mediation medic
medication meditation membership memo mentor mentorship merchandise messenger metabolism meteor microscope midwife migrant
mileage milestone mindful mindfulness mineral miniature minimal mining ministry mixer mobility mosque motivation motorcycle
mover mural musician mythology nanny narrative narrator naval navigator negotiate negotiation newborn newcomer newspaper
niche nominee nonprofit notary novelist nursery nursing nutrient nutritionist obesity observatory occupation odyssey
offline optician optimize optimise orbit orchestra orchestrate orchestration ornament orphan outfit outreach paddle
pageant painter pandemic paperwork parade paragraph paralegal paramedic parish parliament participant partnership
pastry patent patrol pattern pavilion pediatric pedometer penguin perfume periodic personality personnel perspective
pharmacist philosophy photograph photographer photography physician physics physiotherapy pianist picnic pilgrim pioneer
planner planning plumber plumbing poetry pollution portrait postal poster pottery practitioner prayer pregnancy preschool
presentation preset prevention printer prisoner privilege producer productivity profile programmer projector promoter
pronunciation proofread prosecutor prosthetic psychiatrist psychology psychologist publisher quantitative quantum
quarterback quest questionnaire quilt rabbit racing radar railway ranch ranking rapper ratio reactor realtor recap
receptionist recital recruit recruiter recycling referee refinery refugee rehab rehabilitation relaxation remedy rental
reptile rescue researcher reservoir residence residential resilience resort retailer retreat retrieval reunion
reviewer rider ritual rival robotic robotics rocket romance roster rowing rubric rugby runner sailor sanctuary sandwich
satellite scholarship scientist sculpture seafood seminar senator sensor sermon servant shelter sheriff shipment shopper
shortcut shrine sibling simulation singer skater skeleton sketch skier slogan smoothie snorkel sociology solver sommelier
soundtrack souvenir spa spectrum speaker specialist spectator speller sponsor sponsorship spouse stadium stamp statistic
statistics stats stat steward stewardship stitch strategist streamer stretching stylist subtitle subway suburb succession
summit supermarket supervisor supplement supplier surfer surgeon surgical surveillance swimmer syllabus symphony symptom
tactic tactical tailor tattoo taxonomy technician teller tenant terrain textbook textile therapist thermostat thesis
thriller ticketing tile timber toddler tournament township tractor trader trainee trainer transcription translation
translator transparency treasure treasurer tribe tribute triathlon trophy trustee tuition tutorial typist umpire
underwriter undergraduate upcycle utility vaccine vaccination vegan vegetarian vendor venue verification verify vessel
veteran veterinarian vibe villa vineyard violin visa vocal volunteer voter voyage waiter waitress warranty watcher
waterproof weaver webinar welder welfare wellbeing whiteboard wholesaler widow wildlife winery wizard woodwork worship
wrestler wrestling writer yacht yearbook zoo zoning kombucha classifier listing listings minimax rails remap scrim unused
props parlay boolean robust spike verified beloved defined realty estate surf skate skateboard bracket fantasy draft
`;

function words(list: string): string[] { return list.split(/\s+/u).filter(Boolean); }
export const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set(words(FUNCTION_WORDS));
export const ENGLISH_LEXICON: ReadonlySet<string> = new Set([...words(FUNCTION_WORDS), ...words(COMMON_WORDS), ...words(SOFTWARE_WORDS), ...words(MORE_WORDS)]);

const PREFIXES = ["un", "re", "pre", "non", "multi", "self", "auto", "micro", "mini", "sub", "super", "hyper", "co", "over", "out", "cross",
  "inter", "anti", "semi", "mis", "under", "open", "web", "cyber", "meta", "smart", "e"];

const SUFFIXES: readonly (readonly [string, ...string[]])[] = [["'s"], ["ies", "y"], ["es"], ["s"], ["ied", "y"], ["ed", "e"], ["ing", "e"],
  ["iest", "y"], ["ier", "y"], ["er", "e"], ["est", "e"], ["ily", "y"], ["ly", "le"], ["ness"], ["ment"], ["able", "e"], ["less"],
  ["ful"], ["ity", "e"], ["ization", "ize"], ["isation", "ise"], ["ation", "e"], ["ion", "e"], ["or", "e"], ["al"], ["ally"]];
function stems(value: string): string[] {
  const out: string[] = [];
  for (const [suffix, ...endings] of SUFFIXES) {
    if (!value.endsWith(suffix) || value.length - suffix.length < 2) continue;
    const base = value.slice(0, -suffix.length);
    out.push(base, ...endings.map((ending) => base + ending));
    if (/([b-df-hj-np-tv-z])\1$/u.test(base)) out.push(base.slice(0, -1));
  }
  return out.filter((stem) => stem.length >= 3);
}

/**
 * Base form, or a regular inflection/derivation of one, up to two suffixes and one prefix
 * (rides → ride, listings → list, easily → easy, unused → use, predictions → predict).
 */
export function englishWord(word: string): boolean {
  const lower = word.toLowerCase().replaceAll("’", "'");
  if (ENGLISH_LEXICON.has(lower)) return true;
  const roots = [lower, ...PREFIXES.filter((prefix) => lower.length >= prefix.length + 3 && lower.startsWith(prefix))
    .map((prefix) => lower.slice(prefix.length))];
  return roots.some((root) => ENGLISH_LEXICON.has(root)
    || stems(root).some((stem) => ENGLISH_LEXICON.has(stem) || stems(stem).some((inner) => ENGLISH_LEXICON.has(inner))));
}
