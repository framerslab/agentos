import { describe, it, expect, beforeEach } from 'vitest';
import { StatisticalUtilityAI, StatisticalUtilityAIConfig } from '../StatisticalUtilityAI';
import { IUtilityAI, LanguageDetectionResult } from '../IUtilityAI';
import {
  extractTrigrams,
  rankTrigrams,
  computeDistance,
  distancesToConfidences,
  detectLanguageTrigram,
  iso6393To1,
  getSupportedLanguages,
  countScripts,
} from '../trigram-language-profiles';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENGLISH_PASSAGE =
  'The quick brown fox jumps over the lazy dog. This sentence contains ' +
  'every letter of the alphabet and is commonly used for testing purposes.';

const FRENCH_PASSAGE =
  "Tous les êtres humains naissent libres et égaux en dignité et en droits. " +
  "Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.";

const GERMAN_PASSAGE =
  'Alle Menschen sind frei und gleich an Würde und Rechten geboren. ' +
  'Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geist der Brüderlichkeit begegnen.';

const SPANISH_PASSAGE =
  'Todos los seres humanos nacen libres e iguales en dignidad y derechos. ' +
  'Dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros.';

const PORTUGUESE_PASSAGE =
  'Todos os seres humanos nascem livres e iguais em dignidade e em direitos. ' +
  'Dotados de razão e de consciência, devem agir uns para com os outros num espírito de fraternidade.';

const ITALIAN_PASSAGE =
  'Tutti gli esseri umani nascono liberi e uguali in dignità e diritti. ' +
  'Essi sono dotati di ragione e di coscienza e devono agire gli uni verso gli altri in spirito di fratellanza.';

const DUTCH_PASSAGE =
  'Alle mensen worden vrij en gelijk in waardigheid en rechten geboren. ' +
  'Zij zijn begiftigd met verstand en geweten en behoren zich jegens elkander in een geest van broederschap te gedragen.';

const TURKISH_PASSAGE =
  'Bütün insanlar hür, haysiyet ve haklar bakımından eşit doğarlar. ' +
  'Akıl ve vicdana sahiptirler ve birbirlerine karşı kardeşlik zihniyeti ile hareket etmelidirler.';

const POLISH_PASSAGE =
  'Wszyscy ludzie rodzą się wolni i równi pod względem swej godności i swych praw. ' +
  'Są oni obdarzeni rozumem i sumieniem i powinni postępować wobec innych w duchu braterstwa.';

const SWEDISH_PASSAGE =
  'Alla människor äro födda fria och lika i värde och rättigheter. ' +
  'De äro utrustade med förnuft och samvete och böra handla gentemot varandra i en anda av broderskap.';

// Passages for the script stage: one short story told in each script.
const JAPANESE_PASSAGE =
  '古い灯台の下で、少女は毎晩ひとりで海の音を聞いていた。嵐が近づくと、彼女は窓を閉めて静かに祈った。';

const CHINESE_PASSAGE =
  '在古老的灯塔下，女孩每天晚上独自聆听大海的声音。暴风雨来临时，她关上窗户，静静地祈祷。';

const KOREAN_PASSAGE =
  '오래된 등대 아래에서 소녀는 매일 밤 혼자 바다 소리를 들었다. 폭풍이 다가오면 그녀는 창문을 닫고 조용히 기도했다.';

const ARABIC_PASSAGE =
  'تحت المنارة القديمة، كانت الفتاة تستمع كل ليلة إلى صوت البحر وحدها. وعندما تقترب العاصفة، تغلق النافذة وتصلي بهدوء.';

const HINDI_PASSAGE =
  'पुराने प्रकाशस्तंभ के नीचे, लड़की हर रात अकेले समुद्र की आवाज़ सुनती थी। जब तूफ़ान पास आता, तो वह खिड़की बंद करके चुपचाप प्रार्थना करती थी।';

const BENGALI_PASSAGE =
  'পুরনো বাতিঘরের নিচে মেয়েটি প্রতি রাতে একা সমুদ্রের শব্দ শুনত। ঝড় এলে সে জানালা বন্ধ করে চুপচাপ প্রার্থনা করত।';

// Languages that share a profiled script and carry a letter the profiled one
// lacks: Persian (پ, گ, ی), Marathi (ळ).
const PERSIAN_PASSAGE =
  'زیر فانوس دریایی قدیمی، دختر هر شب تنها به صدای دریا گوش می‌داد. وقتی طوفان نزدیک می‌شد، پنجره را می‌بست و آرام دعا می‌کرد.';

const MARATHI_PASSAGE =
  'जुन्या दीपगृहाखाली मुलगी रोज रात्री एकटीच समुद्राचा आवाज ऐकत असे. वादळ जवळ आले की ती खिडकी बंद करून शांतपणे प्रार्थना करत असे.';

const RUSSIAN_PASSAGE =
  'Под старым маяком девочка каждую ночь одна слушала шум моря. Когда приближалась буря, она закрывала окно и тихо молилась.';

const UKRAINIAN_PASSAGE =
  'Під старим маяком дівчинка щоночі сама слухала шум моря. Коли наближалася буря, вона зачиняла вікно і тихо молилася.';

// Russian and Ukrainian fixtures each carry letters only their alphabet has
// (ы in "закрывала"; і in "дівчинка"); Bulgarian and Serbian carry neither set.
const BULGARIAN_PASSAGE =
  'Под стария фар момичето всяка нощ само слушаше шума на морето. Когато бурята наближаваше, тя затваряше прозореца и тихо се молеше.';

const SERBIAN_PASSAGE =
  'Испод старог светионика девојчица је сваке ноћи сама слушала шум мора. Када би се олуја приближила, затварала је прозор и тихо се молила.';

const GREEK_PASSAGE =
  'Κάτω από τον παλιό φάρο, το κορίτσι άκουγε κάθε βράδυ μόνο του τον ήχο της θάλασσας.';

const ENGLISH_WITH_CYRILLIC_NAME =
  'The lighthouse keeper, a quiet man named Алексей, wrote every storm into his log and read the sea like a book.';

const ENGLISH_WITH_JAPANESE_NAME =
  'Our guide, who signs his notes 田中, led us through the old harbor district at dawn and told us about the storms.';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const defaultConfig: StatisticalUtilityAIConfig = {
  utilityId: 'test-lang-detect',
  defaultLanguage: 'en',
};

// ---------------------------------------------------------------------------
// Low-level trigram helpers
// ---------------------------------------------------------------------------

describe('trigram-language-profiles (low-level)', () => {
  describe('extractTrigrams', () => {
    it('returns a non-empty map for a normal string', () => {
      const counts = extractTrigrams('hello world');
      expect(counts.size).toBeGreaterThan(0);
    });

    it('includes word-boundary trigrams', () => {
      const counts = extractTrigrams('hello');
      // " he", "hel", "ell", "llo", "lo "
      expect(counts.has(' he')).toBe(true);
      expect(counts.has('lo ')).toBe(true);
    });

    it('lowercases text before extraction', () => {
      const counts = extractTrigrams('HELLO');
      expect(counts.has(' he')).toBe(true);
      expect(counts.has(' HE')).toBe(false);
    });

    it('returns empty map for empty string', () => {
      const counts = extractTrigrams('');
      expect(counts.size).toBe(0);
    });
  });

  describe('rankTrigrams', () => {
    it('orders trigrams by descending frequency', () => {
      const counts = new Map<string, number>([
        ['abc', 5],
        ['def', 10],
        ['ghi', 1],
      ]);
      const ranked = rankTrigrams(counts);
      expect(ranked[0]).toBe('def');
      expect(ranked[1]).toBe('abc');
      expect(ranked[2]).toBe('ghi');
    });

    it('respects maxRank', () => {
      const counts = new Map<string, number>([
        ['aaa', 3],
        ['bbb', 2],
        ['ccc', 1],
      ]);
      const ranked = rankTrigrams(counts, 2);
      expect(ranked).toHaveLength(2);
    });
  });

  describe('computeDistance', () => {
    it('returns 0 for identical profiles', () => {
      const profile = ['abc', 'def', 'ghi'];
      expect(computeDistance(profile, profile)).toBe(0);
    });

    it('returns higher distance for dissimilar profiles', () => {
      const a = ['abc', 'def', 'ghi'];
      const b = ['xyz', 'uvw', 'rst'];
      const same = computeDistance(a, a);
      const diff = computeDistance(a, b);
      expect(diff).toBeGreaterThan(same);
    });
  });

  describe('distancesToConfidences', () => {
    it('returns confidences summing to ~1.0', () => {
      const result = distancesToConfidences([
        { code: 'eng', distance: 100 },
        { code: 'fra', distance: 500 },
        { code: 'deu', distance: 800 },
      ]);
      const total = result.reduce((s, r) => s + r.confidence, 0);
      expect(total).toBeCloseTo(1.0, 2);
    });

    it('gives highest confidence to lowest distance', () => {
      const result = distancesToConfidences([
        { code: 'eng', distance: 100 },
        { code: 'fra', distance: 500 },
      ]);
      expect(result[0].code).toBe('eng');
      expect(result[0].confidence).toBeGreaterThan(result[1].confidence);
    });

    it('handles empty input', () => {
      expect(distancesToConfidences([])).toEqual([]);
    });
  });

  describe('iso6393To1', () => {
    it('converts known 3-letter codes to 2-letter', () => {
      expect(iso6393To1('eng')).toBe('en');
      expect(iso6393To1('fra')).toBe('fr');
      expect(iso6393To1('deu')).toBe('de');
      expect(iso6393To1('spa')).toBe('es');
    });

    it('passes through unknown codes unchanged', () => {
      expect(iso6393To1('xyz')).toBe('xyz');
    });
  });

  describe('getSupportedLanguages', () => {
    it('returns an array of language codes', () => {
      const langs = getSupportedLanguages();
      expect(langs.length).toBeGreaterThan(10);
      expect(langs).toContain('en');
      expect(langs).toContain('fr');
      expect(langs).toContain('de');
    });
  });

  describe('detectLanguageTrigram', () => {
    it('detects English', () => {
      const results = detectLanguageTrigram(ENGLISH_PASSAGE);
      expect(results[0].language).toBe('en');
      expect(results[0].confidence).toBeGreaterThan(0.05);
    });

    it('detects French', () => {
      const results = detectLanguageTrigram(FRENCH_PASSAGE);
      expect(results[0].language).toBe('fr');
    });

    it('detects German', () => {
      const results = detectLanguageTrigram(GERMAN_PASSAGE);
      expect(results[0].language).toBe('de');
    });

    it('detects Spanish', () => {
      const results = detectLanguageTrigram(SPANISH_PASSAGE);
      expect(results[0].language).toBe('es');
    });

    it('returns "und" for very short text', () => {
      const results = detectLanguageTrigram('hi');
      expect(results[0].language).toBe('und');
    });

    it('respects maxCandidates', () => {
      const results = detectLanguageTrigram(ENGLISH_PASSAGE, { maxCandidates: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns confidences between 0 and 1', () => {
      const results = detectLanguageTrigram(ENGLISH_PASSAGE);
      for (const r of results) {
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// StatisticalUtilityAI.detectLanguage integration
// ---------------------------------------------------------------------------

describe('StatisticalUtilityAI.detectLanguage', () => {
  let utility: IUtilityAI;

  beforeEach(async () => {
    utility = new StatisticalUtilityAI();
    await utility.initialize(defaultConfig);
  });

  it('detects English text', async () => {
    const results = await utility.detectLanguage(ENGLISH_PASSAGE);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].language).toBe('en');
    expect(results[0].confidence).toBeGreaterThan(0);
  });

  it('detects French text', async () => {
    const results = await utility.detectLanguage(FRENCH_PASSAGE);
    expect(results[0].language).toBe('fr');
  });

  it('detects German text', async () => {
    const results = await utility.detectLanguage(GERMAN_PASSAGE);
    expect(results[0].language).toBe('de');
  });

  it('detects Spanish text', async () => {
    const results = await utility.detectLanguage(SPANISH_PASSAGE);
    expect(results[0].language).toBe('es');
  });

  it('detects Portuguese text', async () => {
    const results = await utility.detectLanguage(PORTUGUESE_PASSAGE);
    expect(results[0].language).toBe('pt');
  });

  it('detects Italian text', async () => {
    const results = await utility.detectLanguage(ITALIAN_PASSAGE);
    expect(results[0].language).toBe('it');
  });

  it('detects Dutch text', async () => {
    const results = await utility.detectLanguage(DUTCH_PASSAGE);
    expect(results[0].language).toBe('nl');
  });

  it('detects Turkish text', async () => {
    const results = await utility.detectLanguage(TURKISH_PASSAGE);
    expect(results[0].language).toBe('tr');
  });

  it('detects Polish text', async () => {
    const results = await utility.detectLanguage(POLISH_PASSAGE);
    expect(results[0].language).toBe('pl');
  });

  it('detects Swedish text', async () => {
    const results = await utility.detectLanguage(SWEDISH_PASSAGE);
    expect(results[0].language).toBe('sv');
  });

  it('falls back to default language for very short text', async () => {
    const results = await utility.detectLanguage('hi');
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe('en'); // defaultLanguage from config
    expect(results[0].confidence).toBe(0.1);
  });

  it('falls back to default language for empty string', async () => {
    const results = await utility.detectLanguage('');
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe('en');
    expect(results[0].confidence).toBe(0.1);
  });

  it('respects maxCandidates in options', async () => {
    const results = await utility.detectLanguage(ENGLISH_PASSAGE, { maxCandidates: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.length).toBeGreaterThan(1);
  });

  it('returns results with valid structure', async () => {
    const results = await utility.detectLanguage(FRENCH_PASSAGE);
    for (const result of results) {
      expect(result).toHaveProperty('language');
      expect(result).toHaveProperty('confidence');
      expect(typeof result.language).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('returns results sorted by confidence (highest first)', async () => {
    const results = await utility.detectLanguage(ENGLISH_PASSAGE, { maxCandidates: 5 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });

  it('returns default 3 candidates', async () => {
    const results = await utility.detectLanguage(GERMAN_PASSAGE);
    expect(results).toHaveLength(3);
  });

  it('throws if not initialized', async () => {
    const uninit = new StatisticalUtilityAI();
    await expect(uninit.detectLanguage(ENGLISH_PASSAGE)).rejects.toThrow(/not initialized/i);
  });
});

// ---------------------------------------------------------------------------
// Script stage
// ---------------------------------------------------------------------------

describe('script stage', () => {
  let utility: IUtilityAI;

  beforeEach(async () => {
    utility = new StatisticalUtilityAI();
    await utility.initialize(defaultConfig);
  });

  it.each([
    ['ja', JAPANESE_PASSAGE],
    ['zh', CHINESE_PASSAGE],
    ['ko', KOREAN_PASSAGE],
    ['ar', ARABIC_PASSAGE],
    ['hi', HINDI_PASSAGE],
    ['bn', BENGALI_PASSAGE],
    ['ru', RUSSIAN_PASSAGE],
    ['uk', UKRAINIAN_PASSAGE],
  ])('identifies %s by its script as the only candidate', async (language, passage) => {
    const results = await utility.detectLanguage(passage, { maxCandidates: 32 });
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe(language);
    expect(results[0].confidence).toBeGreaterThan(0.9);
    expect(results[0].confidence).toBeLessThanOrEqual(1);
  });

  it('keeps English first when the prose names someone in another script', async () => {
    for (const passage of [ENGLISH_WITH_CYRILLIC_NAME, ENGLISH_WITH_JAPANESE_NAME]) {
      const results = await utility.detectLanguage(passage, { maxCandidates: 32 });
      expect(results[0].language).toBe('en');
      expect(results.length).toBeGreaterThan(1);
    }
  });

  it('scores Latin-script text against the Latin-script profiles only', async () => {
    const results = await utility.detectLanguage(ENGLISH_PASSAGE, { maxCandidates: 32 });
    const languages = results.map((r) => r.language);
    expect(languages).toHaveLength(13);
    expect(languages).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'tr', 'vi', 'pl', 'sv', 'da', 'no']));
    for (const r of results) {
      expect(Math.round(r.confidence * 10000) / 10000).toBe(r.confidence);
    }
  });

  it('falls back to the default language for a script no profile covers', async () => {
    const results = await utility.detectLanguage(GREEK_PASSAGE);
    expect(results).toEqual([{ language: 'en', confidence: 0.1 }]);
  });

  it.each([
    ['Bulgarian', BULGARIAN_PASSAGE],
    ['Serbian', SERBIAN_PASSAGE],
    // ӧ is outside both alphabets, so the ы that stays in the passage decides nothing.
    ['Russian with a letter of another Cyrillic alphabet', `${RUSSIAN_PASSAGE} Кӧрт.`],
    ['Persian', PERSIAN_PASSAGE],
    ['Marathi', MARATHI_PASSAGE],
  ])('leaves %s undetermined instead of reading it as a profiled language', async (_name, passage) => {
    const results = await utility.detectLanguage(passage, { maxCandidates: 32 });
    expect(results).toEqual([{ language: 'en', confidence: 0.1 }]);
  });

  it('needs five letters before a script decides', async () => {
    for (const fragment of ['😀😀😀😀😀中', '!!!!!!!!!! ア ア', '1234 5678 9 한']) {
      expect(await utility.detectLanguage(fragment)).toEqual([{ language: 'en', confidence: 0.1 }]);
    }
  });

  it('caps a script decision at maxCandidates', () => {
    expect(detectLanguageTrigram(JAPANESE_PASSAGE, { maxCandidates: 0 })).toEqual([]);
    expect(detectLanguageTrigram(ENGLISH_PASSAGE, { maxCandidates: 0 })).toEqual([]);
  });

  it('counts a long text in one pass', () => {
    const long = `${JAPANESE_PASSAGE}${ENGLISH_PASSAGE}`.repeat(2000);
    const counts = countScripts(long);
    const japaneseLetters = countScripts(JAPANESE_PASSAGE).letters;
    const englishLetters = countScripts(ENGLISH_PASSAGE).letters;
    expect(counts.letters).toBe((japaneseLetters + englishLetters) * 2000);
    expect(counts.dominant).toBe(englishLetters > japaneseLetters ? 'latin' : 'cjk');
  });

  it('falls back to the default language for text without letters', async () => {
    const results = await utility.detectLanguage('2026 — 12:30 — 42 % … ★★★★★ — 3.14159');
    expect(results).toEqual([{ language: 'en', confidence: 0.1 }]);
  });

  it('counts letters per script and finds the dominant group', () => {
    expect(countScripts(JAPANESE_PASSAGE)).toMatchObject({ dominant: 'cjk' });
    expect(countScripts(JAPANESE_PASSAGE).kana).toBeGreaterThan(0);
    expect(countScripts(CHINESE_PASSAGE)).toMatchObject({ dominant: 'cjk', kana: 0 });
    expect(countScripts(ENGLISH_WITH_CYRILLIC_NAME).dominant).toBe('latin');
    expect(countScripts(GREEK_PASSAGE).dominant).toBeNull();
  });
});
