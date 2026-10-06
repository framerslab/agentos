/**
 * @fileoverview Trigram-based language detection profiles and scoring algorithm.
 *
 * Detection runs in two stages. The script stage counts the text's letters
 * per writing system: a script only one profiled language uses (Hangul,
 * Arabic, Devanagari, Bengali, Han and kana) decides the language outright,
 * and Cyrillic text is decided by the letters only Russian or only Ukrainian
 * uses, or left undetermined. Latin-script text goes to the trigram stage,
 * which follows Cavnar & Trenkle (1994): build a ranked trigram frequency
 * profile from the input and compare it against the Latin-script reference
 * profiles; the profile with the lowest "out-of-place" distance wins.
 *
 * There are 21 reference profiles, each a frequency-ranked list of 64 to 236
 * trigrams (fewer for the Japanese, Chinese and Korean profiles, which hold
 * two-character entries the trigram stage never matches; the script stage
 * covers those languages).
 *
 * ISO 639-3 codes are used throughout (e.g. "eng", "spa", "cmn") to stay
 * consistent with the franc ecosystem.
 *
 * @module backend/agentos/nlp/ai_utilities/trigram-language-profiles
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A ranked list of trigrams for one language (most frequent first). */
export interface LanguageProfile {
  /** ISO 639-3 code */
  code: string;
  /** Human-readable label (English) */
  name: string;
  /** Ordered trigrams, index 0 = most frequent. */
  trigrams: string[];
}

// ---------------------------------------------------------------------------
// Reference profiles — top-300 trigrams per language
// ---------------------------------------------------------------------------

/**
 * Pre-computed trigram profiles for the most widely spoken languages.
 * Each array is ordered by descending frequency in representative corpora.
 *
 * The trigrams include leading/trailing spaces (word boundaries) which
 * dramatically improve accuracy for short texts.
 */
const PROFILES: LanguageProfile[] = [
  {
    code: 'eng',
    name: 'English',
    trigrams: (
      ' th|the| an|he |nd |and|ion|tio| of|of |tion|ati|for| in|on |sth|ed | to| co|es | re|er |al | fo|in |ent|hat| is|is |re |ng | pr|te | th|his|tha|an | ha|en |ing| st|ou |nt |to |or |at |st |it | be| wh| on|ve | se|se |all|are| al|rea|ere| wi|ith|wit| it|as | as|was|pro|not|her|ll |ons|con| no|ear|ect|men|ive|com|ver| wa|ne |int|nte| or|est| de|res|ess|nce| ca|ter|cti|ted|be |ght| he|rig|eve|ce |per|hts|ts | ev|igh|ry | sh|one| ma|nal|le |hal|ty |sha|ble|ati| en|ome|y t|tat| di|ery|hav|oth|ial|enc|t t|ave|sta|thi| ar|s a|d t|s t|e o|ade|dis|s o| un|rom|fre|ree|dom|nti|eed|nat|rat|e a| pe|e s|n t|nal|ona|ity|ns |e t|l a|tit|tle|led|ny |ful|any|und|nte|ote|nte|n a|hum|uma|man|hou|y a|t o|eri|e i| su|h t|l o|nde|e r|lit|equ|unt| fr| hu|unt|qua| eq|ual|y o|ge |s a|ote|cte|pec|oci|soc|ia |age|duc|edu|ct |ich|olo|out|uc |cia|e p|oce|els|d a|rso|son|d o|ple|igh|wor|n s|ork|rk |ers|o t| ow|own|eed|e c|ren|n o|tec|eld| fa|rot|e e|min|her|s e'
    ).split('|'),
  },
  {
    code: 'spa',
    name: 'Spanish',
    trigrams: (
      ' de|de |os |ión|ció|ón |aci|la | la|el |en | el|es | en| co|ión|der|ere|rec|ech|cho| y |as |al |a l|nte|do |ent|las|s d|a d|ho |los|na |ene|tod|con| to|oda|da |tie|ien|que| qu|per| pr|o d|a e|ad |ers|rso| pe|son|ona|nes|res|ida|dad|cia| se|te |ado| lo|est|ra |ion|a p|pro|n d|e l| su|ar | li|lib|ibe|ber|rta|tad|des|o a| po|por| re|men|ión|tos|dos|nci|e d|n e|tra|mie|s e|s y|nto|sta|ter|com|ia |nac|e e| na|s p|nal|una|ant|a c| un|cio|ser| in|les|o e|io |as |ual|igу|gua|s n|su |ale|e s|odo|s l|ual|e a| es|er |se |par|ara|a t|ament|o s|ial|a s|soc|oci|ica|ndi|ind|dis| di|ica|div|ivi|vid|du |o p|fun|und|nda|dam|ame|ament|ent|tal|os |el |pre|r a|int|no |bre|s a|las|or |ley|ido|l d|rio|re |ien|s s|acc|rib|ibu|cla|cas|tec|ote|rot|as |ones|nes|sus|ib |tra|ran|ntr'
    ).split('|'),
  },
  {
    code: 'fra',
    name: 'French',
    trigrams: (
      ' de|de |es |ion|et |ent|on |tio| le|le |tion|ait| et|les|des| la| co|la | dr|nt |oit|roi|dro| to|re |ne |it |e d|e l|e e| un|ns |tou|out|ute|men|ons|te | a |e p| pr| en| qu|ue |er |s d|que|une| pe| so|ant| li|lib|ibe|ber|rté|té |a d|son|per|eme|nt |s l|ux |par|con|ati|s e|our|res|e s| au|e c|ont|ou |pro|om |omm|mme|tra|dan|ans|al | ou| sa| da|aux|com|nat|e a|ers|nne| in|nce|e t|s a| pa|r l|tre|nte|ser|its|ts | se|ell|n d|san| po|lle|nal|ale|les| di|ui |ce | re|ité|ali|ien|s p|ntr|int|ter|tat|soc|oci|ial|cia|iqu|t d|s s|ass| as| na|rat|lit|ran|eur|ons|a l|ect|ens|a p|nda|nte|eme|és |aut|tat|ous| ch|n e|e n|rso|onn|air|s c|ut |pou|qui|cti|ble|lor|ind|cha|ond|t a|ect|pri| ét|emm|dis|tes|rel|rot|ote|tec|ége|gal|n a|rs |ces|igr|t l|ir |é d|a c'
    ).split('|'),
  },
  {
    code: 'deu',
    name: 'German',
    trigrams: (
      'en |er |der| de|die|ie | di|und| un|ein|nd |ung|che|cht|ich|sch|eit|ech|rec|ine| au|ht |gen|ch | ge|ren|auf| re|lic|ng |den|in |te |ver| da|as | ei| in|das|und|ede| je|jed|es | ha| zu|at |ler|hen|hat|aft| ve|ter|ers|uf |it |n d|ode| od|rei|nge|lle|fte|rde|all|nde|eih|fre|hei|erd|wer|n s|n u|ner|sei|ei |nen|and|ent|run|ger|sta| be|tig|nte|ten|ige| se|unt|nge|sse|cht|ber|nat|atio|tio|ion|al |cha|est|lic|gle|lei|men|ung|bes|ies|ach|ges|son|ist|st |ere|t d|e u|n g|dar|abe|arf|rf |ien|nte|r d|ste|ruc|uck|n a| st|rit|em |haf|etz|ges|her|ebe|ben| ni|nic|le |lun|r s|ft |s R|ung|ohn|ohn|geh|eho|ege|des|d d|n e| gr|gru|und|nd |ndl|lag|age|tra|aat|spr|anz|n i|rn |rt |gle|ner|r g|ken|s d'
    ).split('|'),
  },
  {
    code: 'por',
    name: 'Portuguese',
    trigrams: (
      ' de|de |os |ção|ão |to |do |ent|ito|eit|rei|ire|dir| di|o d|da |ade| to|tod|oda| a |em |nte|as |men|a p|es | qu|que| co|er |no | se|a d|dos|o a|com| e |te |o e|al |s d|o s|ida| em|dad| pr| ou|con|ou |a e|ões|est|e d|s e|e a|a t|pro| pe|per|res|ar |ia |tra|ser|a a|nto|uma|ion|ões|nal|hum|uma|ano|man|s p|cia|açã|açõ| es|nci|na |ame|nac|ter|sta| na|era|ess|o p|ra |e s|lib|ibe|ber|erd|rda|a l|s n|ais|ado|int|o o|e e|a c|s a| po| in|pes|soa| re|sso|oa |a s|por|ntr|das|odo|o c| li|ual|oci|soc|ial|o t|ido|e p|par|dos|ua |is |ica|s o|a n|seu|eu |tos|ici|nda|fun|und|dam| fu|ame|men|ent|tal|s t|ção|ações|e l|pre|dis|ens|ria|r a|les|ant|nid|açã|uni'
    ).split('|'),
  },
  {
    code: 'ita',
    name: 'Italian',
    trigrams: (
      ' di|to |la | in|di |e d|ne |rit|iri|dir|ion|tto|itt|one|re |le |ell|lla|ni |azi|zio| de|ent|tti| al|o d|in |nte| e | la|ato|lio|gli|del|a d|i d|ess|ere|a p|all|per|no |ita| og|ogn| co|gni| ha|ha | pr|e i|uo |suo| su|ndi|ind|div|ivi|vid|duo|o a|con|nza|al |ter|il |ità| il|e e|i e|e a|ser|men|pro|nto| ne|o i|ual|ri |e l|lle|ta |te |ale|i i|na |sta|ali|ont|ono|o e|i a|tra|o s|ti |o p|are|i p|ien|a s|anz|a l|i o|lib|ibe|ber|ert|rtà| li|tà |qua|lsi|sia|a c|uni|ché|pre|che|erà|za |nal| un|est|ia |dis|naz|i s|soc|oci|ial|cia|rat|tut|azi|pri|non|n c|e p|io |sen|o c|lit|nti|ant|ers|una|rso|son|ona|e s|ssi|ass|ico|tat|rio|eri'
    ).split('|'),
  },
  {
    code: 'nld',
    name: 'Dutch',
    trigrams: (
      'en |de | de| he|het|an |van| va|et |een|der| ee|cht|ech|rec| re|n d|ing| en|den| ge|ede|ver|nde|ng |ht |gen|ijk| op|op |eli|lij|ere|ren|te |er |n e|oor|n v|and|ij | in| be|ier|ien|zij|eft|hee|eef|ft |t r|in | zi| of|of | te|aal|e v|aan|n o|eid|nge|t o| on|ond| we|rde|sta| ve|al |ord|wor|nat|ers|rij|ijd|hei|vri|men|ion|tie|n g| vr| vo|ati|vol|n z|lle|le |e o| st|bes|die|ie |sch|ger|ied|ter|n i|per|eni|it |nt |dig|e e| ie|nis|ste|e g|est|ege|gel|eri|rin|n h|tig|n w|e b| al|ema|ree|nst|erk|cht|len|ns |t h|e s|ete|t d|lin|ove|erw|r d|e n|ten|el |ig |ele|d v|lke|elk|iet|t e|gin|ege|ope|pen|e r|n a|bij|rwo|wer|e a|s e|t v|lan|ard|str|jn |ijn|che| da|esc|her|n b|ven|age|e d|wet|nd |bes'
    ).split('|'),
  },
  {
    code: 'rus',
    name: 'Russian',
    trigrams: (
      ' пр|ого| и |ние|пра|ств|рав|ени|ост| на|на | ка|ова| об|ть |ать|ий |ани|ие |ажд|каж|то | по|сво|ажд|жды|дый| в | св| не|ет | до| ра|его|ест|во |обо|бод|аво|ных|ой |ли |ело|ова|ных|е и|й ч|дый|обр|раз|ком|не |о п|вob|ное| им| ил|или| ко|ого|ова|ить|ных|ные|ого|ого|ных|ого|ого|ных|ого|ого|ных|ого'
    ).split('|'),
  },
  {
    code: 'jpn',
    name: 'Japanese',
    trigrams: (
      'の |する|して|ない|ある| の|こと|れる|いる|ている|った|から|ので|って|なっ|それ|もの|ます|です|した|ない|られ|ため|この|とい|のは|たい|のが|でき|のを|これ|なら|との|ても|ても|よう|にな|のに|てい|とは|もの|かっ|った|ると|であ|には|にお|おい|のは|まし|とが|です|でし|ませ|せん|かし|しか|まで|まで|から|もの|のか|だっ|こと|なの|のは|ると|とし|のは|いう|だと|がで|きる|てき|もな|たの|なけ|かど|ども|たち'
    ).split('|'),
  },
  {
    code: 'cmn',
    name: 'Chinese (Mandarin)',
    trigrams: (
      '的 | 的|人人|有权|权利| 人|和 |任何| 任|何人|不得|利 |每个| 每|个人|自由| 和|国 | 有| 不|得 |会 |社会| 社|受 |其他|他 | 其|享有| 享|保护| 保|等 |平等| 平|法律| 法| 自|由 |在 | 在|为 | 为|应 | 应|所有| 所|何 |生活| 生|教育| 教|一切| 一|切 |权 | 国|家 |际 | 际|本 | 本|条 | 条'
    ).split('|'),
  },
  {
    code: 'arb',
    name: 'Arabic',
    trigrams: (
      ' ال|الح|لحق|حق |ية |في | في|وال| أو|أو |من | من|لكل| لك|كل |ان | أن|حق | وا|ة ا|الم| عل|حري|رية|ها |على|لى |ته |ات |الت|ون |أن |كان| وا|ما |الأ|ة و|مة |لا |ام |شخص| لل|أي |ي أ| كل|مم |الع|لة |إلى|لي |م ا|لأم|اء |ل ف|ة أ|قوق|أمم|ق ف|دة |لعا|عال|مي | إل|حد |واح|أحد|ين |ق ا|ت ا| حر|نسا|سان|إنس|لإن|عة |ون |الا|نون|انو|قان'
    ).split('|'),
  },
  {
    code: 'hin',
    name: 'Hindi',
    trigrams: (
      'के |का |में| के| का| और|और |ार | है|है |की |ने | की|ों | को|को |प्र| प्|ा क|ी क|से | मे|ें | से|ना |ता | कि|किस|कि |में|िसी|सी | हो|ति |ती |े क|ा ह|ा म|या |ा स|िक |ात |ही |ान |ाव |ले | या|ओं |र क|ी स|ही | जा|था |ित | पर|पर |ने | ऐस|ऐसे| अप|अपन|हो |ेश |ाओं|देश| दे|अधि|धिक|कार|े म|जा |समा|माज| सम|िया|राष|ाष्|ष्ट|है।|गा |क अ|री |ा ज| इस|इस |विश|ाँ |ं क|राप|र स|न क|प्त|ा अ| रा| सभ|सभी|भी |शिक|िक्|क्ष|क्षा|ारा|ा प|ीय |हित|े ल|लिए| लि|र म|ेश्|शा |र प|सा |ं म|स्व| स्|ुक्|मुक|्वत|वतं|तंत|ंत्|त्र|्रत|ा ब| अध'
    ).split('|'),
  },
  {
    code: 'ben',
    name: 'Bengali',
    trigrams: (
      'র |প্র| প্|ের | এব|এবং|বং |ার |ে |তি |কার| সম| অধ|অধি|ধিক|িকা|ান |য়ে| তা|তার| কো|কোন|োন|না | তা|করা|মান|াধী|নো |াধি|হার|বে |ে প|ায়|া হ|িয়|পায|ব্য|্যক|ক্ত|রাধ|স্ব|্বা|বাধ|াধী|ীনত|নতা|তা | স্|ক্ষ|রতি|প্ত|রে |করি|্রত|ির |্রে|যুক|সকল| সক|কল | যে| হই|দেশ| দে|সমা|মাজ| রা|রাষ|াষ্|ষ্ট|যায|াষ্'
    ).split('|'),
  },
  {
    code: 'kor',
    name: 'Korean',
    trigrams: (
      '의 |는 |에 |을 |이 |권리|리를| 모|모든| 권|든 |하는|는 | 있|있다| 또|또는| 자|자유| 하|유 |할 | 및| 그|을 |인은| 사|사회|회의| 대|대한|가 | 국|한다|이나|나 |로 |국가| 어|어떠|떠한|한 |되어|어야|보장|장 |에게|게 | 받|받을|야 | 한|적 | 인|으로|지 |누구|구나|에서|서 |있는|위한|한다|다 |경우| 위|가진|진다|위하|여 |과 |인의| 기|기본|본적|의무|무 |다른|른 |정 |방법|법 |동등|등한| 법|법률|법에|에의'
    ).split('|'),
  },
  {
    code: 'tur',
    name: 'Turkish',
    trigrams: (
      ' ve|ve |ler|bir|ir |hak| bi|in |lar| ha|er |ak |ır |ası|kla|akl|an |ına| he| ol|her|eri|arı|nda|ini|de | ka|lik|ya |esi|ın |ek |eti|rın|ile| ta|mek|ine|eri|yet|ını|la |ara|na |rin|dır|ket|aya| va|ola|lan|ınd|ard|ret|dir|var|lar| bu|bul|hak|ede|ne |ima|rak|un |ill|le |rle|mak|si |lma|tle|riy|den|ama|mle|eml|eme|tle|tle| ge|ala|ulu|mil|ille|lle|let|nis|hiç|içb|çbi|ilm|nma|eya|hay|lis|lik|dan|kar|ır |ığı|ama|da |ser|erb|rbe|bes|est|e h|tir|ması|şma|her|ulu'
    ).split('|'),
  },
  {
    code: 'vie',
    name: 'Vietnamese',
    trigrams: (
      'nh |ng | ng|ông| nh|ều | qu|quy|uyề|yền|ền |ung| có|có |ền |và | và|ới |mọi| mọ|ọi |ười| ng|ngư|gườ|ườ | tự|tự |ĩ |ều |ác |các| cá|được|ượ | đư|ợc | tr|n t|ị |bất| bấ|ất |ai |ân |ức | kh|hội| xã|xã | do| ph|i n|gia| gi|hôn|in |hin| th|ất | ho| đề|đều|đượ|trư|ước|ướ |ở |ào |nào|hay| ha| bả|bảo|ảo | mộ|một|ột |uốc|quố|ốc |ình|hữ |nhữ|n c|ã h|ên |với| vớ|à |ự d|của| củ'
    ).split('|'),
  },
  {
    code: 'pol',
    name: 'Polish',
    trigrams: (
      'nie| pr|pra|raw| do|ie |nia| po|go | i |ch |ego| ni| za|do | w |ści|oln|wol|ani|ości| ma| ka| wo|awo|wan|ej |wo |ażd|każ|dej| na|na |sta|prz|rze|zez| cz|czł|złó|łow|owi|wie|ek |est| je|ma |jak|nek|neg|neg|ych| lu|lub|ub |rod|nar| rów|rów|ówn|wno|noś|ym |pow|owy|odo|obo| sw|swo|kie|stw|jed|odn|dno|owe|enn|bod|dze|ów |nic|za |owo|nym|ają|prz|zan|iej|ich|ny |ien|rac|czn|ron|orz|m p|ań |ony|ić |ony|kra|raj|aju| kr|o d|olno|lno|noś|ośc|ci |wsz|sze|inn|d p| ob|owy|mi |ist|e p'
    ).split('|'),
  },
  {
    code: 'ukr',
    name: 'Ukrainian',
    trigrams: (
      ' пр|пра|рав|на | на|ння|ого| за|ати|ня |ти | і | по|во |або| аб|має| ко|кож|ожн|жна|ів |люд|юди|дин|ина| лю|сво|вob|обо|бод|і п|е п|ає |го | не|не |ути|бут|ере| бу|ств|ій |їх |ій | ві|від|ідн|анн|ому|ом |ост|ене|нен|ри |при|ння|нос|а п|ова|ват|їхн|хні|ні |а з|ії |ста|его|а н|а с| та|та | до|до |ень|ися|них|ною|ті |ним|ому|ми |ван|бе |без| бе|воб| сво|ано|а в|ії |о п|ніх|ної|ьно| ос|осо|соб|оби|бис|ист| в |в | ви| ін| рі|рів|івн|вно|нос|ості|сті|у п|ово|ній'
    ).split('|'),
  },
  {
    code: 'swe',
    name: 'Swedish',
    trigrams: (
      ' oc|och|ch | rä|rät|ätt|tt |er |för|ör |ing|var| ti| fö|til|ill|ll |en |ska|nde| ha| en|and|ell| fr| el|ler|lig|het|av |ler| av|lle| de| sk|den|att|har| ut|nga| in|ens|igh|ghe|la |ter|gen| so|som|om | be| st|fri|rih|ihe|ete|ten|det|eni|nin|nna|na |tta|de |iga| va|ka |sam| at| si| la|und|re |ans| ge|ran|da |rätt|ade|isk|tta|sta|ion|tio|alla|lla|ona|ner|är |ras|ati|kli|äns|nal|at |sin|igt|r r|d f|med| me|kap|dra|äll|r s|lik|ikl|r f|n s|ans|änd|mot| mo|tat|lan|stä|ndé|ndé|erä|rkl|för|kla|nd |del|rin|nat|dig|gna|tig|tti|e s|h f|s f|lid|nsk|nsl|an |ska|dde|a f|dom| do'
    ).split('|'),
  },
  {
    code: 'dan',
    name: 'Danish',
    trigrams: (
      'er |en | og|og | re|ret| ti|til|il |nde| de|et |for|lle| ha| en| fo|ing|den|hed|gen|ler|ell|hed| at| el|lig|de |der|hed| fr| et| er|els|ver|ige| af|af |har|nge| be|fri|rih|ihe|ede|and|ion|le |ske|igh|ghe|tte|nd |ska|eri|al |ter|ere|ens|enh|nhe|hed| st| sk|hve|r r|ret|enn|ationer|nes|alle|lle|tio|ke |es |n f|age|ng |at |te |res|ved|ove|lig| li|ove|t t|r s|des|r f|e f|tig|ans|ons|nat|rin|tion|on |und|re |rig|gru|run|ndl|ige| an|lov| lo|sam|isk|ren| in|ne |on |nes|lan|lke|stå|tat|for| al| me| sa|n s|h f|end|hed|ge |arn|r e|rne|enn|mod| mo|vis| vi|nne|sti|e s|hed|med|d e|r t|ikk|kke|per|rso|son|ona'
    ).split('|'),
  },
  {
    code: 'nor',
    name: 'Norwegian',
    trigrams: (
      'er |en |et |for|or | re|ret|til| ti|il | og|og |den|ler| de|lle| ha| en|nde|ing|ell| fo| el|ede|lig|het|gen| fr|ter|ver|tte|der|har| et| at|igh|ghe|nge|rih|ihe|fri|and|eri|al |ens|ion|hed| be| st|le |ke |ska|de |ere|ske|tig|ng |res|all|lle|nes|ans|tio|hve|enh|nhe|r r|ene|ret|r s|ove|n f|rin|ationer|ung|age|te |ige|sam|nat|und|ons|nd |r f| sk|at |es |t t|lov|ikk|kke|gru|run|ndl|ige|lan|tat|ren|isk|nne|arn|r e|rne|vis|end|mod|med|ned|per|rso|son|ona|nen|sta|nna|na |ne |dom|e s|sti|s f|d e|ell|seg|inn|e o|ger|n s| an|ike|ket|re |ige| la| me|e f|h f|nnl|lag|om |ave|rhe|her'
    ).split('|'),
  },
];

// ---------------------------------------------------------------------------
// Trigram extraction
// ---------------------------------------------------------------------------

/**
 * Extract trigrams from text, including word-boundary trigrams
 * (padded with spaces).  The text is lowercased and normalised first.
 */
export function extractTrigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Normalise: lowercase, collapse whitespace, trim
  const clean = ` ${text.toLowerCase().replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

  for (let i = 0; i < clean.length - 2; i++) {
    const tri = clean.substring(i, i + 3);
    counts.set(tri, (counts.get(tri) || 0) + 1);
  }
  return counts;
}

/**
 * Build a ranked list of trigrams from frequency counts (most frequent first).
 */
export function rankTrigrams(counts: Map<string, number>, maxRank = 300): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRank)
    .map(([tri]) => tri);
}

// ---------------------------------------------------------------------------
// Distance scoring
// ---------------------------------------------------------------------------

/**
 * Compute the "out-of-place" distance between an input ranked trigram list
 * and a reference profile.  Lower = better match.
 *
 * For each trigram in the input profile, find its position in the reference.
 * If not found, apply a penalty equal to `maxRank`.  Sum all displacements.
 */
export function computeDistance(inputRanked: string[], referenceProfile: string[], maxRank = 300): number {
  const refIndex = new Map<string, number>();
  for (let i = 0; i < referenceProfile.length; i++) {
    refIndex.set(referenceProfile[i], i);
  }

  let distance = 0;
  for (let i = 0; i < inputRanked.length; i++) {
    const tri = inputRanked[i];
    const refPos = refIndex.get(tri);
    if (refPos !== undefined) {
      distance += Math.abs(i - refPos);
    } else {
      distance += maxRank; // penalty for trigram not in reference
    }
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Confidence normalisation
// ---------------------------------------------------------------------------

/**
 * Convert raw distances to 0-1 confidence scores.
 *
 * The best (lowest-distance) language gets the highest confidence.
 * We use inverse-distance normalisation:
 *   score_i = (1 / (1 + distance_i)) / sum(1 / (1 + distance_j))
 */
export function distancesToConfidences(
  distances: Array<{ code: string; distance: number }>,
): Array<{ code: string; confidence: number }> {
  if (distances.length === 0) return [];

  const inverses = distances.map(d => ({
    code: d.code,
    inverse: 1 / (1 + d.distance),
  }));

  const total = inverses.reduce((sum, d) => sum + d.inverse, 0);

  return inverses
    .map(d => ({
      code: d.code,
      confidence: total > 0 ? d.inverse / total : 0,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// ISO 639-3 -> ISO 639-1 mapping (common subset)
// ---------------------------------------------------------------------------

const ISO_639_3_TO_1: Record<string, string> = {
  eng: 'en', spa: 'es', fra: 'fr', deu: 'de', por: 'pt',
  ita: 'it', nld: 'nl', rus: 'ru', jpn: 'ja', cmn: 'zh',
  arb: 'ar', hin: 'hi', ben: 'bn', kor: 'ko', tur: 'tr',
  vie: 'vi', pol: 'pl', ukr: 'uk', swe: 'sv', dan: 'da',
  nor: 'no',
};

/**
 * Convert an ISO 639-3 code to ISO 639-1 if a mapping exists,
 * otherwise return the 3-letter code as-is.
 */
export function iso6393To1(code: string): string {
  return ISO_639_3_TO_1[code] || code;
}

// ---------------------------------------------------------------------------
// Script stage
// ---------------------------------------------------------------------------

/** Writing systems the profiles cover. Han and kana count as one group. */
export type ScriptGroup = 'latin' | 'cyrillic' | 'arabic' | 'devanagari' | 'bengali' | 'hangul' | 'cjk';

// Each pattern counts letters only: a script's combining marks (Devanagari
// and Bengali vowel signs, Arabic vowel points) are not letters, so the
// lookahead keeps every group's count within the text's letter count.
const SCRIPT_GROUP_PATTERNS: ReadonlyArray<readonly [ScriptGroup, RegExp]> = [
  ['latin', /(?=\p{L})\p{Script=Latin}/gu],
  ['cyrillic', /(?=\p{L})\p{Script=Cyrillic}/gu],
  ['arabic', /(?=\p{L})\p{Script=Arabic}/gu],
  ['devanagari', /(?=\p{L})\p{Script=Devanagari}/gu],
  ['bengali', /(?=\p{L})\p{Script=Bengali}/gu],
  ['hangul', /(?=\p{L})\p{Script=Hangul}/gu],
  ['cjk', /(?=\p{L})[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
];

const LETTER = /\p{L}/gu;
const KANA = /(?=\p{L})[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/**
 * Letters of the Russian alphabet that the Ukrainian alphabet lacks. The hard
 * sign is left out: Russian rarely uses it and Bulgarian uses it constantly.
 */
const RUSSIAN_ONLY_LETTERS = /[ыэёЫЭЁ]/gu;
/** Letters of the Ukrainian alphabet that the Russian alphabet lacks. */
const UKRAINIAN_ONLY_LETTERS = /[іїєґІЇЄҐ]/gu;
/**
 * Letters of other Cyrillic alphabets (Belarusian, Serbian, Macedonian,
 * Kazakh, Kyrgyz, Mongolian, Tatar, Bashkir, Tajik, Uzbek, Chuvash) that
 * neither Russian nor Ukrainian uses. No profile covers those languages.
 */
const OTHER_CYRILLIC_LETTERS = /[ўјљњћђџѓќѕәғқңөұүһҳҷӣӯҡҙҫҗӑӗӳ]/giu;

/** Japanese prose mixes kana with Han characters; Chinese has no kana. */
const MIN_KANA_SHARE_FOR_JAPANESE = 0.1;

/** The script each reference profile is written in. */
const PROFILE_SCRIPT: Record<string, ScriptGroup> = {
  eng: 'latin', spa: 'latin', fra: 'latin', deu: 'latin', por: 'latin', ita: 'latin', nld: 'latin',
  tur: 'latin', vie: 'latin', pol: 'latin', swe: 'latin', dan: 'latin', nor: 'latin',
  rus: 'cyrillic', ukr: 'cyrillic',
  arb: 'arabic', hin: 'devanagari', ben: 'bengali', kor: 'hangul', jpn: 'cjk', cmn: 'cjk',
};

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface ScriptCounts {
  /** Letters (Unicode category L) in the text. */
  letters: number;
  /**
   * The covered script group holding more than half of the letters, or null
   * when no group does (mixed scripts, or a script no profile covers).
   */
  dominant: ScriptGroup | null;
  /** Letters in the dominant group (0 when there is none). */
  dominantLetters: number;
  /** Hiragana and Katakana letters. */
  kana: number;
}

/** Count the text's letters per covered script group and find the dominant one. */
export function countScripts(text: string): ScriptCounts {
  const letters = countMatches(text, LETTER);
  let dominant: ScriptGroup | null = null;
  let dominantLetters = 0;
  for (const [group, pattern] of SCRIPT_GROUP_PATTERNS) {
    const count = countMatches(text, pattern);
    if (count > dominantLetters) {
      dominant = group;
      dominantLetters = count;
    }
  }
  if (letters === 0 || dominantLetters * 2 <= letters) {
    return { letters, dominant: null, dominantLetters: 0, kana: countMatches(text, KANA) };
  }
  return { letters, dominant, dominantLetters, kana: countMatches(text, KANA) };
}

/**
 * The language the text's script decides, as an ISO 639-3 code, or null when
 * the script does not decide it (always for Latin; for Cyrillic when the
 * deciding letters are missing, mixed, or belong to another alphabet).
 */
function languageOfScript(text: string, counts: ScriptCounts): string | null {
  switch (counts.dominant) {
    case 'hangul':
      return 'kor';
    case 'arabic':
      return 'arb';
    case 'devanagari':
      return 'hin';
    case 'bengali':
      return 'ben';
    case 'cjk':
      return counts.kana >= counts.dominantLetters * MIN_KANA_SHARE_FOR_JAPANESE ? 'jpn' : 'cmn';
    case 'cyrillic': {
      if (countMatches(text, OTHER_CYRILLIC_LETTERS) > 0) return null;
      const russianOnly = countMatches(text, RUSSIAN_ONLY_LETTERS);
      const ukrainianOnly = countMatches(text, UKRAINIAN_ONLY_LETTERS);
      if (russianOnly > 0 && ukrainianOnly === 0) return 'rus';
      if (ukrainianOnly > 0 && russianOnly === 0) return 'ukr';
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DetectLanguageOptions {
  /** Maximum number of candidate results to return (default 3). */
  maxCandidates?: number;
  /** Minimum text length in characters to attempt detection (default 10). */
  minLength?: number;
}

/**
 * Detect the language of a text string.
 *
 * A script that only one profiled language uses decides the result on its
 * own: the result is that language alone, with the share of the text's
 * letters written in that script as its confidence. Latin-script text is
 * scored against the Latin-script trigram profiles, and the candidates come
 * back ranked, with inverse-distance confidences normalised over that set and
 * rounded to four decimals. Text shorter than `minLength`, text with no
 * covered script holding more than half of its letters, and Cyrillic text
 * its letters do not decide return `und`.
 *
 * @param text - The input text to analyse
 * @param options - Detection tuning knobs
 * @returns Array of `{ language, confidence }` sorted by confidence descending.
 *          `language` uses ISO 639-1 codes (e.g. 'en', 'fr') where possible.
 */
export function detectLanguageTrigram(
  text: string,
  options?: DetectLanguageOptions,
): Array<{ language: string; confidence: number }> {
  const maxCandidates = options?.maxCandidates ?? 3;
  const minLength = options?.minLength ?? 10;

  if (!text || text.trim().length < minLength) {
    return [{ language: 'und', confidence: 0 }]; // undetermined
  }

  const scripts = countScripts(text);
  if (!scripts.dominant) {
    return [{ language: 'und', confidence: 0 }];
  }

  const decided = languageOfScript(text, scripts);
  if (decided) {
    return [{ language: iso6393To1(decided), confidence: round4(scripts.dominantLetters / scripts.letters) }];
  }
  if (scripts.dominant !== 'latin') {
    return [{ language: 'und', confidence: 0 }];
  }

  const inputCounts = extractTrigrams(text);
  const inputRanked = rankTrigrams(inputCounts);

  if (inputRanked.length === 0) {
    return [{ language: 'und', confidence: 0 }];
  }

  const distances = PROFILES.filter(profile => PROFILE_SCRIPT[profile.code] === 'latin').map(profile => ({
    code: profile.code,
    distance: computeDistance(inputRanked, profile.trigrams),
  }));

  const scored = distancesToConfidences(distances);

  return scored
    .slice(0, maxCandidates)
    .map(s => ({
      language: iso6393To1(s.code),
      confidence: round4(s.confidence),
    }));
}

/**
 * Get the list of all supported language codes (ISO 639-1 where possible).
 */
export function getSupportedLanguages(): string[] {
  return PROFILES.map(p => iso6393To1(p.code));
}
