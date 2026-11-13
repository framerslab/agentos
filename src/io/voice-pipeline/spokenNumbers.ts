/**
 * @module voice-pipeline/spokenNumbers
 *
 * The number rule of `spokenMatch`: a run of digits, and a run of a language's cardinal words that its table reads as
 * one integer from 0 to 999,999, each become that integer in ASCII digits, so "3", "three", "tres" and "drei" are one
 * word. A run the table cannot read is left as its words, and compares as words.
 *
 * The tables are built from CLDR's spell-out rules (https://github.com/unicode-org/cldr/tree/main/common/rbnf) for
 * en, es, fr, de, pt, it, ko, zh and hi, one table a language keyed by its primary subtag, with the common spellings
 * beside CLDR's (the feminine forms, "zwo", Brazilian and European Portuguese teens, Belgian and Swiss French tens).
 * A language with no table folds digit runs alone. Digits of any script count (Devanagari digits read as ASCII), and a
 * digit run with a leading zero ("0100", "007") is a code, compared as written, so a voice that drops its zero does not
 * match. A grouped digit string counts in the grouping of the tag's region, read from the platform's CLDR data
 * (`Intl.NumberFormat`): "1,000" in English and in es-MX, "1.000" in German and in es, "1 000" in French and in pt-PT,
 * whose narrow no-break space NFKC makes a space, so the groups arrive as words of their own and are joined; a runtime
 * with no data for the language keeps the table's grouping. A word that mixes digits and letters is cut where they meet
 * ("365일" is "365" and "일", "3pm" is "3" and "pm").
 *
 * German and Italian write a number as one word ("dreihundertfünfundsechzig", "trecentosessantacinque"), so a word of
 * those languages is read when it splits wholly into number words; Korean's native numbers ("스물하나") the same. Chinese
 * and Korean's Sino-Korean numbers are read by place value (三百六十五, 삼백육십오), and a Chinese word is cut into its
 * numeral characters and the rest first, since the segmenter may keep "三点" as one word.
 *
 * Limits, each compared as written: a decimal, an ordinal, a date, a time of day, a fraction, a signed number, a
 * percent and an amount of money (`spokenWords` keeps a number written with a separator, a sign, a currency or a
 * percent as one word); a number with an article ("a hundred"); a year said in pairs ("twenty twenty-six"); a Chinese
 * number whose last digit stands for a place it does not name ("一百一", "三万五"). A line that writes one of them in
 * digits while a voice's transcript writes it in words does not match. Both texts go through the same rule, so a limit
 * refuses a match and never makes one. A word that is also a numeral (Korean 이, "this", is also 2) folds on both
 * sides; the two are said alike, so a transcript that writes the other form still matches.
 */

/** A value added to the number, the bound of the value that may follow it, or a multiplier. */
type Item =
  | { kind: 'add'; value: number; next: number }
  | { kind: 'times'; value: number; bound: number; after?: After }
  | { kind: 'and' };

/**
 * What a multiplier needs before it: nothing in its group (`'empty'`, Italian "mille"), a value of two or more
 * (`'more'`, Italian "mila"), or exactly one value (French "vingt" after "quatre").
 */
type After = 'empty' | 'more' | number;

/** What the last item read was, which a joining word ("and", "y", "e", "et") may follow. */
type Role = 'unit' | 'tens' | 'hundreds' | 'times' | 'big';

/** How a digit string is grouped: one word a pattern accepts, or groups of three digits written as words of their own. */
type Grouping = RegExp | 'space';

/** A place-value table: Chinese, and Korean's Sino-Korean numbers. */
interface Places {
  /** Each digit character and its value, the zeros among them. */
  digits: Record<string, number>;
  /** Each place character below a myriad: ten, a hundred, a thousand. */
  places: Record<string, number>;
  /** Each myriad character: ten thousand. */
  myriads: Record<string, number>;
  /** The zeros that may stand for an empty place inside a number (Chinese 零 and 〇). */
  gaps: string;
  /** Whether a last digit after any place is its units (Korean 백일 is 101), or only after ten or a zero. */
  unitsAfterAnyPlace: boolean;
  /** Characters a word must end with for the number to go on into the next word (Korean writes 만 오천). */
  joinAfter?: string;
  /** Whether each word is cut into its numeral characters and the rest (a script written without spaces). */
  splitWords: boolean;
}

/** A language's source table, as written below. */
interface Source {
  /** Values added: the words space-separated in value order from `first` by `step`, a slash between spellings. */
  adds: Array<[words: string, first: number, step: number, next: number]>;
  /** Multipliers: the spellings slash-separated, the value, the bound of the value that may follow, what comes first. */
  times?: Array<[spellings: string, value: number, bound: number, after?: After]>;
  /** Joining words, and the roles each may follow. */
  joins?: Record<string, Role[]>;
  /** Whether one word may be several number words written together. */
  compound?: boolean;
  /** The word between a unit and its tens inside a compound (German "einundzwanzig"). */
  unitAndTens?: string;
  places?: Places;
  /** A digit string grouped in the language's way, where the platform has no data for it. */
  grouping?: Grouping;
}

/** A built table. */
interface Language {
  words: Map<string, Item[]>;
  longest: number;
  compound: boolean;
  joins: Map<string, Role[]>;
  places?: Places;
  grouping?: Grouping;
}

/** One word of the text, or one part of a word cut where digits meet letters; `digits` holds a digit part in ASCII. */
interface Piece {
  text: string;
  digits?: string;
  /** The index of the word the piece came from. */
  word: number;
}

const MAX = 999_999;
/** The most words one number is read across. */
const MAX_RUN = 24;
/** The most ways one compound word is split. */
const MAX_SPLITS = 16;
/** The longest compound word read, above German's longest spelling up to 999,999 (737,737 with "dreissig": 67 letters). */
const MAX_COMPOUND = 80;

/** Grouped digit strings, in digits of any script. */
const COMMA = /^\p{Nd}{1,3}(?:,\p{Nd}{3})+$/u;
const DOT = /^\p{Nd}{1,3}(?:\.\p{Nd}{3})+$/u;
const INDIAN = /^(?:\p{Nd}{1,3}(?:,\p{Nd}{3})+|\p{Nd}{1,2}(?:,\p{Nd}{2})+,\p{Nd}{3})$/u;

const SOURCES: Record<string, Source> = {
  en: {
    adds: [
      ['zero one two three four five six seven eight nine', 0, 1, 0],
      ['ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen', 10, 1, 0],
      ['twenty thirty forty fifty sixty seventy eighty ninety', 20, 10, 10],
    ],
    times: [['hundred', 100, 100], ['thousand', 1000, 1000]],
    joins: { and: ['times', 'big'] },
    grouping: COMMA,
  },
  es: {
    adds: [
      ['cero uno/un/una dos tres cuatro cinco seis siete ocho nueve', 0, 1, 0],
      ['diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve', 10, 1, 0],
      ['veinte veintiuno/veintiún/veintiuna veintidós veintitrés veinticuatro veinticinco veintiséis veintisiete veintiocho veintinueve', 20, 1, 0],
      ['treinta cuarenta cincuenta sesenta setenta ochenta noventa', 30, 10, 10],
      ['cien', 100, 0, 0],
      ['ciento', 100, 0, 100],
      ['doscientos/doscientas trescientos/trescientas cuatrocientos/cuatrocientas quinientos/quinientas seiscientos/seiscientas setecientos/setecientas ochocientos/ochocientas novecientos/novecientas', 200, 100, 100],
    ],
    times: [['mil', 1000, 1000]],
    joins: { y: ['tens'] },
    grouping: DOT,
  },
  fr: {
    adds: [
      ['zéro un/une deux trois quatre cinq six sept huit neuf', 0, 1, 0],
      ['dix', 10, 0, 10],
      ['onze douze treize quatorze quinze seize', 11, 1, 0],
      ['vingt trente quarante cinquante', 20, 10, 10],
      ['soixante', 60, 0, 20],
      ['septante huitante/octante nonante', 70, 10, 10],
    ],
    // "quatre-vingts" is four twenties; a value up to nineteen follows it, as one does "soixante".
    times: [['vingt/vingts', 20, 20, 4], ['cent/cents', 100, 100], ['mille/mil', 1000, 1000]],
    joins: { et: ['tens'] },
    grouping: 'space',
  },
  de: {
    adds: [
      ['null eins/ein/eine zwei/zwo drei vier fünf sechs sieben acht neun', 0, 1, 0],
      ['zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn', 10, 1, 0],
      ['zwanzig dreißig/dreissig vierzig fünfzig sechzig siebzig achtzig neunzig', 20, 10, 10],
    ],
    times: [['hundert', 100, 100], ['tausend', 1000, 1000]],
    compound: true,
    unitAndTens: 'und',
    grouping: DOT,
  },
  pt: {
    adds: [
      ['zero um/uma dois/duas três quatro cinco seis sete oito nove', 0, 1, 0],
      ['dez onze doze treze catorze/quatorze quinze dezesseis/dezasseis dezessete/dezassete dezoito dezenove/dezanove', 10, 1, 0],
      ['vinte trinta quarenta cinquenta sessenta setenta oitenta noventa', 20, 10, 10],
      ['cem', 100, 0, 0],
      ['cento', 100, 0, 100],
      ['duzentos/duzentas trezentos/trezentas quatrocentos/quatrocentas quinhentos/quinhentas seiscentos/seiscentas setecentos/setecentas oitocentos/oitocentas novecentos/novecentas', 200, 100, 100],
    ],
    times: [['mil', 1000, 1000]],
    joins: { e: ['tens', 'hundreds', 'big'] },
    grouping: DOT,
  },
  it: {
    adds: [
      ['zero uno/un/una due tre/tré quattro cinque sei sette otto nove', 0, 1, 0],
      ['dieci undici dodici tredici quattordici quindici sedici diciassette diciotto diciannove', 10, 1, 0],
      // The tens lose their last vowel before "uno" and "otto": "ventuno", "trentotto".
      ['venti/vent trenta/trent quaranta/quarant cinquanta/cinquant sessanta/sessant settanta/settant ottanta/ottant novanta/novant', 20, 10, 10],
    ],
    times: [['cento/cent', 100, 100], ['mille', 1000, 1000, 'empty'], ['mila', 1000, 1000, 'more']],
    compound: true,
    grouping: DOT,
  },
  hi: {
    adds: [
      [
        'शून्य एक दो तीन चार पाँच/पांच छह/छः सात आठ नौ दस ग्यारह बारह तेरह चौदह पन्द्रह/पंद्रह सोलह सत्रह अठारह उन्नीस ' +
          'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस ' +
          'सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास ' +
          'इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ ' +
          'उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी ' +
          'चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानबे बानबे तिरानबे चौरानबे पंचानबे छियानबे सत्तानबे अट्ठानबे ' +
          'निन्यानबे',
        0,
        1,
        0,
      ],
    ],
    times: [['सौ', 100, 100], ['हज़ार/हजार', 1000, 1000], ['लाख', 100_000, 100_000]],
    grouping: INDIAN,
  },
  ko: {
    // The native numbers; the Sino-Korean ones are read by place value.
    adds: [
      ['하나/한 둘/두 셋/세 넷/네 다섯 여섯 일곱 여덟 아홉', 1, 1, 0],
      ['열', 10, 0, 10],
      ['스물/스무 서른 마흔 쉰 예순 일흔 여든 아흔', 20, 10, 10],
    ],
    compound: true,
    places: {
      digits: { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 },
      places: { 십: 10, 백: 100, 천: 1000 },
      myriads: { 만: 10_000 },
      gaps: '',
      unitsAfterAnyPlace: true,
      joinAfter: '만',
      splitWords: false,
    },
    grouping: COMMA,
  },
  zh: {
    adds: [],
    places: {
      digits: { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 },
      places: { 十: 10, 百: 100, 千: 1000 },
      myriads: { 万: 10_000, 萬: 10_000 },
      gaps: '零〇',
      unitsAfterAnyPlace: false,
      splitWords: true,
    },
    grouping: COMMA,
  },
};

const built = new Map<string, Language | undefined>();

/** The table for a BCP-47 tag's primary subtag, built once; undefined for a language with none. */
function languageOf(language: string): Language | undefined {
  const primary = (language.split(/[-_]/)[0] ?? '').toLowerCase();
  if (built.has(primary)) return built.get(primary);
  const source = Object.prototype.hasOwnProperty.call(SOURCES, primary) ? SOURCES[primary] : undefined;
  const table = source ? build(source) : undefined;
  built.set(primary, table);
  return table;
}

/** A spelling as the word rule writes it. */
function key(spelling: string): string {
  return spelling.normalize('NFKC').toLowerCase();
}

function build(source: Source): Language {
  const words = new Map<string, Item[]>();
  const put = (spellings: string, item: Item): void => {
    for (const spelling of spellings.split('/')) {
      const k = key(spelling);
      words.set(k, [...(words.get(k) ?? []), item]);
    }
  };
  for (const [list, first, step, next] of source.adds) {
    list.split(' ').forEach((spellings, at) => put(spellings, { kind: 'add', value: first + at * step, next }));
  }
  for (const [spellings, value, bound, after] of source.times ?? []) put(spellings, { kind: 'times', value, bound, after });
  if (source.unitAndTens) put(source.unitAndTens, { kind: 'and' });
  const joins = new Map<string, Role[]>(Object.entries(source.joins ?? {}).map(([word, roles]) => [key(word), roles]));
  const longest = Math.max(0, ...[...words.keys()].map((k) => k.length));
  return { words, longest, compound: source.compound ?? false, joins, places: source.places, grouping: source.grouping };
}

const ND = /\p{Nd}/u;
const ALL_DIGITS = /^\p{Nd}+$/u;
const LETTERS_AND_DIGITS = /^[\p{L}\p{M}\p{Nd}]+$/u;
const DIGIT_RUNS = /\p{Nd}+|[^\p{Nd}]+/gu;

/** A decimal digit's value in any script: Unicode encodes each script's digits zero to nine in one run. */
function digitValue(char: string): number {
  const point = char.codePointAt(0) ?? 0;
  if (point >= 0x30 && point <= 0x39) return point - 0x30;
  let start = point;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start -= 1;
  return (point - start) % 10;
}

/** A digit string in ASCII, its leading zeros kept: "0100" reads as no number and compares as written. */
function asciiDigits(text: string): string {
  return [...text].filter((char) => ND.test(char)).map(digitValue).join('');
}

/** A grouping's parts: the first group of a number grouped with spaces, and each group after it. */
const SPACED_HEAD = /^\p{Nd}{1,3}$/u;
const SPACED_GROUP = /^\p{Nd}{3}$/u;

const groupings = new Map<string, Grouping | undefined>();
const MAX_GROUPINGS = 64;

/**
 * How a BCP-47 tag's region groups a digit string, from the platform's CLDR data: the separator `Intl.NumberFormat`
 * writes between groups, and the Indian grouping where it writes groups of two ("12,34,567"). A separator that is no
 * comma, point or space (Swiss German's apostrophe) needs no rule, since the word rule keeps "1'000" one word and drops
 * the apostrophe. A tag the platform refuses, or a language it has no data for, keeps the table's grouping.
 */
function groupingOf(language: string, table: Language | undefined): Grouping | undefined {
  if (groupings.has(language)) return groupings.get(language);
  let grouping = table?.grouping;
  try {
    const format = new Intl.NumberFormat(language);
    const primary = (tag: string): string => (tag.split(/[-_]/)[0] ?? '').toLowerCase();
    if (primary(format.resolvedOptions().locale) === primary(language)) {
      const parts = format.formatToParts(1_234_567);
      const group = parts.find((part) => part.type === 'group')?.value.normalize('NFKC');
      const sizes = parts.filter((part) => part.type === 'integer').map((part) => part.value.length);
      if (group === ',') grouping = sizes.length > 2 && sizes[sizes.length - 2] === 2 ? INDIAN : COMMA;
      else if (group === '.') grouping = DOT;
      else if (group !== undefined && /^\s$/u.test(group)) grouping = 'space';
      else if (group !== undefined) grouping = undefined;
    }
  } catch {
    // A tag the platform refuses keeps the table's grouping.
  }
  if (groupings.size >= MAX_GROUPINGS) groupings.clear();
  groupings.set(language, grouping);
  return grouping;
}

/** Whether a character is one of a place-value table's numerals. */
function isNumeral(char: string, places: Places): boolean {
  return char in places.digits || char in places.places || char in places.myriads;
}

/** A run of letters cut into its runs of numeral characters and the rest. */
function cutNumerals(run: string, places: Places): string[] {
  const parts: string[] = [];
  let current = '';
  let numeral = false;
  for (const char of run) {
    const next = isNumeral(char, places);
    if (current && next !== numeral) {
      parts.push(current);
      current = '';
    }
    current += char;
    numeral = next;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * The text's words as pieces: a digit word as its digits, a number grouped with spaces as one piece, and a word that
 * mixes digits and letters cut where they meet.
 */
function piecesOf(words: readonly string[], language: Language | undefined, grouping: Grouping | undefined): Piece[] {
  const pieces: Piece[] = [];
  const places = language?.places;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (grouping === 'space' && SPACED_HEAD.test(word) && SPACED_GROUP.test(words[index + 1] ?? '')) {
      let end = index + 1;
      while (end < words.length && SPACED_GROUP.test(words[end]!)) end += 1;
      const text = words.slice(index, end).join(' ');
      pieces.push({ text, digits: asciiDigits(text), word: index });
      index = end - 1;
    } else if ((grouping instanceof RegExp && grouping.test(word)) || ALL_DIGITS.test(word)) {
      pieces.push({ text: word, digits: asciiDigits(word), word: index });
    } else if (LETTERS_AND_DIGITS.test(word)) {
      for (const run of word.match(DIGIT_RUNS) ?? []) {
        if (ALL_DIGITS.test(run)) pieces.push({ text: run, digits: asciiDigits(run), word: index });
        else if (places?.splitWords) for (const part of cutNumerals(run, places)) pieces.push({ text: part, word: index });
        else pieces.push({ text: run, word: index });
      }
    } else {
      // Inner punctuation makes a decimal, a time or a code: the word compares as written.
      pieces.push({ text: word, word: index });
    }
  }
  return pieces;
}

/** The role an added value plays for a joining word. */
function roleOf(value: number): Role {
  if (value >= 20 && value < 100 && value % 10 === 0) return 'tens';
  if (value >= 100 && value < 1000 && value % 100 === 0) return 'hundreds';
  return 'unit';
}

/** A number read so far. */
interface Reading {
  /** The value of the groups a myriad-scale multiplier closed. */
  total: number;
  /** The last such multiplier, which the next must be below. */
  big: number;
  /** The value the group's multipliers made ("three hundred" in "three hundred sixty"). */
  group: number;
  /** The group's last multiplier, which the next in the group must be below. */
  groupTimes: number;
  groupItems: number;
  /** The values added since the group's last multiplier. */
  part: number;
  partItems: number;
  /** A value added next must be below this. */
  bound: number;
  items: number;
  last?: Role;
}

const START: Reading = {
  total: 0,
  big: Infinity,
  group: 0,
  groupTimes: Infinity,
  groupItems: 0,
  part: 0,
  partItems: 0,
  bound: 1000,
  items: 0,
};

const valueOf = (reading: Reading): number => reading.total + reading.group + reading.part;

/** A reading that stays within the cap, and within the last myriad-scale multiplier. */
function within(reading: Reading): Reading | undefined {
  if (valueOf(reading) > MAX) return undefined;
  if (reading.big !== Infinity && reading.group + reading.part >= reading.big) return undefined;
  return reading;
}

function fits(after: After | undefined, count: number, value: number): boolean {
  if (after === undefined) return true;
  if (after === 'empty') return count === 0;
  if (after === 'more') return count > 0 && value >= 2;
  return count > 0 && value === after;
}

/** The reading with one more item, or undefined when the item cannot follow. */
function apply(reading: Reading, item: Item): Reading | undefined {
  if (item.kind === 'and') return undefined;
  if (item.kind === 'add') {
    // A zero is a number alone, never part of one.
    if (item.value >= reading.bound || (item.value === 0 && reading.items > 0)) return undefined;
    return within({
      ...reading,
      part: reading.part + item.value,
      partItems: reading.partItems + 1,
      groupItems: reading.groupItems + 1,
      items: reading.items + 1,
      bound: item.next,
      last: roleOf(item.value),
    });
  }
  if (reading.partItems > 0 && reading.part === 0) return undefined;
  if (item.value < 1000) {
    const base = reading.partItems === 0 ? 1 : reading.part;
    if (item.value >= reading.groupTimes || !fits(item.after, reading.partItems, base)) return undefined;
    if (item.after === undefined && base >= item.value) return undefined;
    return within({
      ...reading,
      group: reading.group + base * item.value,
      groupTimes: item.value,
      groupItems: reading.groupItems + 1,
      part: 0,
      partItems: 0,
      items: reading.items + 1,
      bound: item.bound,
      last: 'times',
    });
  }
  const base = reading.groupItems === 0 ? 1 : reading.group + reading.part;
  if (item.value >= reading.big || base === 0 || !fits(item.after, reading.groupItems, base)) return undefined;
  if (reading.big !== Infinity && base * item.value >= reading.big) return undefined;
  return within({
    ...reading,
    total: reading.total + base * item.value,
    big: item.value,
    group: 0,
    groupTimes: Infinity,
    groupItems: 0,
    part: 0,
    partItems: 0,
    items: reading.items + 1,
    bound: item.bound,
    last: 'big',
  });
}

function applyAll(reading: Reading, items: readonly Item[]): Reading | undefined {
  let next: Reading | undefined = reading;
  for (const item of items) {
    next = next && apply(next, item);
    if (!next) return undefined;
  }
  return next;
}

/** German's unit, "und" and tens inside one word, read as one value: "einundzwanzig" is 21. */
function joinUnitAndTens(items: readonly Item[]): Item[] | undefined {
  const joined: Item[] = [];
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at]!;
    if (item.kind !== 'and') {
      joined.push(item);
      continue;
    }
    const unit = joined.pop();
    const tens = items[at + 1];
    if (unit?.kind !== 'add' || unit.value < 1 || unit.value > 9) return undefined;
    if (tens?.kind !== 'add' || roleOf(tens.value) !== 'tens') return undefined;
    joined.push({ kind: 'add', value: unit.value + tens.value, next: 0 });
    at += 1;
  }
  return joined;
}

/** The ways a word splits wholly into number words, longest first, each as its items. */
function splits(word: string, language: Language): Item[][] {
  if (word.length > MAX_COMPOUND) return [];
  const found: Item[][] = [];
  const walk = (at: number, items: Item[]): void => {
    if (found.length >= MAX_SPLITS) return;
    if (at === word.length) {
      const joined = joinUnitAndTens(items);
      if (joined && joined.length > 0) found.push(joined);
      return;
    }
    for (let end = Math.min(word.length, at + language.longest); end > at; end -= 1) {
      for (const item of language.words.get(word.slice(at, end)) ?? []) walk(end, [...items, item]);
    }
  };
  walk(0, []);
  return found;
}

/** Each reading of a piece as items: a digit piece as one value, a word by the table. */
function readingsOf(piece: Piece, language: Language, cache: Map<Piece, Item[][]>): Item[][] {
  const kept = cache.get(piece);
  if (kept) return kept;
  let readings: Item[][];
  if (piece.digits !== undefined) {
    readings = /^(?:0|[1-9]\d{0,5})$/.test(piece.digits) ? [[{ kind: 'add', value: Number(piece.digits), next: 0 }]] : [];
  } else if (language.compound) {
    readings = splits(piece.text, language);
  } else {
    readings = (language.words.get(piece.text) ?? []).filter((item) => item.kind !== 'and').map((item) => [item]);
  }
  cache.set(piece, readings);
  return readings;
}

/** The longest number the table's words read from `start`, with the index after it. */
function readWords(
  pieces: readonly Piece[],
  start: number,
  language: Language,
  cache: Map<Piece, Item[][]>
): { end: number; value: number } | undefined {
  let best: { end: number; value: number } | undefined;
  const visit = (reading: Reading, at: number): void => {
    if (reading.items > 0 && (!best || at > best.end)) best = { end: at, value: valueOf(reading) };
    if (at >= pieces.length || at - start >= MAX_RUN) return;
    const piece = pieces[at]!;
    for (const items of readingsOf(piece, language, cache)) {
      const next = applyAll(reading, items);
      if (next) visit(next, at + 1);
    }
    const roles = reading.items > 0 && piece.digits === undefined ? language.joins.get(piece.text) : undefined;
    const following = pieces[at + 1];
    if (roles && reading.last && roles.includes(reading.last) && following) {
      for (const items of readingsOf(following, language, cache)) {
        if (items[0]?.kind !== 'add') continue;
        const next = applyAll(reading, items);
        if (next) visit(next, at + 2);
      }
    }
  };
  visit(START, start);
  return best;
}

/** A run of place-value tokens read as one number, or undefined. A token is a character or a digit piece's value. */
function readPlaceValue(tokens: ReadonlyArray<string | number>, places: Places): number | undefined {
  const only = tokens[0];
  if (tokens.length === 1 && typeof only === 'string' && places.digits[only] === 0) return 0;
  let total = 0;
  let myriad = Infinity;
  let section = 0;
  let place = Infinity;
  let digit: number | undefined;
  let written = false;
  let gap = false;
  for (const [at, token] of tokens.entries()) {
    const value = typeof token === 'number' ? token : places.digits[token];
    if (value !== undefined && (typeof token === 'number' || value > 0)) {
      if (digit !== undefined) return undefined;
      digit = value;
      written = typeof token === 'number';
      continue;
    }
    if (typeof token === 'number') return undefined;
    if (value === 0) {
      if (!places.gaps.includes(token) || digit !== undefined || (section === 0 && total === 0)) return undefined;
      gap = true;
      continue;
    }
    const p = places.places[token];
    if (p !== undefined) {
      if (p >= place || (digit !== undefined && digit > 9)) return undefined;
      section += (digit ?? 1) * p;
      place = p;
      digit = undefined;
      gap = false;
      continue;
    }
    const m = places.myriads[token];
    if (m === undefined || m >= myriad || (written && section > 0)) return undefined;
    let grouped = section + (digit ?? 0);
    if (grouped === 0) {
      if (at > 0) return undefined;
      grouped = 1;
    }
    total += grouped * m;
    myriad = m;
    section = 0;
    place = Infinity;
    digit = undefined;
    written = false;
    gap = false;
  }
  if (digit !== undefined) {
    if (written && (place !== Infinity || total > 0)) return undefined;
    const units = gap || place === 10 || places.unitsAfterAnyPlace || (place === Infinity && total === 0);
    if (!units) return undefined;
    section += digit;
  } else if (gap) {
    return undefined;
  }
  const value = total + section;
  return value <= MAX ? value : undefined;
}

/** The longest place-value number from `start`, read across pieces, with the index after it. */
function readPlaces(
  pieces: readonly Piece[],
  start: number,
  places: Places
): { end: number; value: number } | undefined {
  const tokens: Array<string | number> = [];
  let named = false;
  let best: { end: number; value: number } | undefined;
  for (let at = start; at < pieces.length && at - start < MAX_RUN; at += 1) {
    const piece = pieces[at]!;
    const before = pieces[at - 1];
    // Parts of one word always join; Korean goes on into the next word only after a myriad, as in 삼만 오천.
    if (at > start && before !== undefined && before.word !== piece.word && places.joinAfter !== undefined) {
      if (!places.joinAfter.includes(before.text.slice(-1))) break;
    }
    if (piece.digits !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(piece.digits)) break;
      tokens.push(Number(piece.digits));
    } else {
      const chars = [...piece.text];
      if (!chars.every((char) => isNumeral(char, places))) break;
      tokens.push(...chars);
      named = true;
    }
    if (!named) continue;
    const value = readPlaceValue(tokens, places);
    if (value !== undefined) best = { end: at + 1, value };
  }
  return best;
}

/**
 * The words with each number folded: a run of digits and a run of the language's cardinal words read as one integer
 * from 0 to 999,999 each become that integer in ASCII digits. A run the table cannot read is left as its words.
 *
 * @param words - A text's words, as `spokenWords` writes them.
 * @param language - The text's language, a BCP-47 tag; its primary subtag picks the table.
 * @returns The words, each number one word in ASCII digits.
 */
export function foldNumbers(words: readonly string[], language: string): string[] {
  const table = languageOf(language);
  const pieces = piecesOf(words, table, groupingOf(language, table));
  const cache = new Map<Piece, Item[][]>();
  const folded: string[] = [];
  for (let at = 0; at < pieces.length; ) {
    const byWords = table ? readWords(pieces, at, table, cache) : undefined;
    const byPlaces = table?.places ? readPlaces(pieces, at, table.places) : undefined;
    const read = byPlaces && (!byWords || byPlaces.end > byWords.end) ? byPlaces : byWords;
    if (read) {
      folded.push(String(read.value));
      at = read.end;
      continue;
    }
    const piece = pieces[at]!;
    folded.push(piece.digits ?? piece.text);
    at += 1;
  }
  return folded;
}
