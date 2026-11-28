'use strict';
// Avatar-Übersetzer – Server (Prototyp, nur Testdaten).
// Nur Node-Bordmittel, keine zusätzlichen Pakete.
// Es werden keine Texte, Bilder oder Tonaufnahmen gespeichert oder geloggt.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');

// ---------- Stabilität: unerwartete Fehler abfangen (nur Fehlerart loggen, nie Inhalte) ----------
// Ein einzelner Fehler (z. B. abgebrochene Verbindung) soll nie den ganzen Server beenden.
const fehlerArt = (e) => (e && (e.code || e.name)) || typeof e;
process.on('unhandledRejection', (e) => { console.log(`Warnung: unbehandelter Fehler (${fehlerArt(e)}) – Server läuft weiter.`); });
process.on('uncaughtException', (e) => { console.log(`Warnung: unerwarteter Fehler (${fehlerArt(e)}) – Server läuft weiter.`); });
const START_ZEIT = Date.now();
// Version für die Gesundheits-Route: Stand (Änderungszeit) von server.js, z. B. „2026-11-28T00:40“.
const VERSION = (() => { try { return new Date(fs.statSync(__filename).mtimeMs).toISOString().slice(0, 16); } catch { return 'unbekannt'; } })();

const scrypt = promisify(crypto.scrypt);
const rag = require('./rag');   // Wissensspeicher für Test-Patienten (BM25 + Claude-Citations)
const pd = require('./patientendaten');   // Unterlagen, Seitenbilder, Zeitstrahl, Onboarding (baut auf rag.js auf)
const gd = require('./gedaechtnis');
// Dashboard (Termine + Medikamentenplan, eigener Agent). Optional: fehlt die Datei, läuft der Server ohne.
let dashboard = null;
try { dashboard = require('./dashboard'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.log('Dashboard: Modul konnte nicht geladen werden.'); }   // Patienten-Gedächtnis: Fakten aus Gesprächen und Unterlagen (werkzeuge/GEDAECHTNIS_EINBAU.md)

const PORT = Number(process.env.PORT) || 3000;
// Standard: nur dieser Rechner. Fürs Handy im WLAN in .env HOST=0.0.0.0 setzen.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'lokal', 'nutzer.json');

const IDLE_MS = 15 * 60 * 1000;        // Abmeldung nach 15 Min. Inaktivität
const MAX_MS = 8 * 60 * 60 * 1000;     // spätestens nach 8 Stunden
const MAX_BODY = 20 * 1024;            // 20 KB reichen für Anmeldung und Nutzerverwaltung
const MIN_PW = 10;

// ---------- KI-Anbindung (Übersetzen) ----------
const PROMPT_FILE = path.join(__dirname, 'prompt', 'system.md');
const PROMPT_MARKE = '<!-- PLATZHALTER';     // solange das in system.md steht, ist der Prompt nicht fertig
const MAX_BODY_UEBERSETZEN = 64 * 1024;      // 64 KB nur für /api/uebersetzen
const MAX_TEXT = 15000;                      // höchstens 15.000 Zeichen Originaltext
const KI_TIMEOUT_MS = 60 * 1000;             // nach 60 Sekunden abbrechen
const ANBIETER = 'Anthropic (Cloud, USA – nicht DSGVO-konform)';
const MODI = ['einfach'];                    // "zielsprache" folgt, wenn die Sprache feststeht
// Modelle, die den serverseitigen Ersatz bei Ablehnung ("fallbacks") kennen
const FALLBACK_MODELLE = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
// Nur die technische Form der Antwort – keine inhaltlichen Regeln (die stehen in prompt/system.md).
const ANTWORT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    nicht_uebersetzbare_stellen: { type: 'array', items: { type: 'string' } },
    hinweise: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'nicht_uebersetzbare_stellen', 'hinweise'],
  additionalProperties: false,
};

// ---------- D-ID Avatar (Echtzeit-Video über WebRTC) ----------
// Der Server macht alle Aufrufe an D-ID, der Browser baut nur die Videoverbindung auf.
// Der Avatar-Agent hat KEINE eigene KI: er spricht genau den Text, den wir schicken.
const DID_URL = 'https://api.d-id.com';
const DID_AGENT_FILE = path.join(__dirname, 'lokal', 'did-agent.json');     // alter Einzel-Avatar (Emma)
const DID_AGENTS_FILE = path.join(__dirname, 'lokal', 'did-agents.json');   // { avatarId: agentId }
const DID_BILD_BASIS = 'https://create-images-results.d-id.com/DefaultPresenters/';
// Sprachen, die jeder Avatar sprechen kann. "anweisung" ist ein rein technischer Zusatz für die KI,
// "echo" der Satzanfang im Echo-Test (ohne KI).
const SPRACHEN = {
  de: { name: 'Deutsch', locale: 'de-DE', anweisung: 'Antworte auf Deutsch.', echo: 'Ich habe verstanden: ' },
  en: { name: 'English', locale: 'en-US', anweisung: 'Antworte auf Englisch.', echo: 'I understood: ' },
  fr: { name: 'Français', locale: 'fr-FR', anweisung: 'Antworte auf Französisch.', echo: 'J’ai compris : ' },
  tr: { name: 'Türkçe', locale: 'tr-TR', anweisung: 'Antworte auf Türkisch.', echo: 'Anladım: ' },
  ar: { name: 'العربية', locale: 'ar-SA', anweisung: 'Antworte auf Arabisch.', echo: 'فهمت: ' },
};
// Überbrückung im Hybrid-Gespräch: spricht der Avatar SOFORT, wenn Claude gefragt wird (bevor dessen Antwort da ist).
// Rein gesprächstechnische Sätze (keine medizinischen Inhalte), je Sprache und Grund ('unterlagen' | 'nachdenken' | 'erinnern').
// Locker formuliert (Nutzerwunsch 28.11.2026). Türkisch/Arabisch bitte vom Team gegenlesen.
const UEBERBRUECKUNG = {
  de: { unterlagen: ['Moment, ich schau kurz in deine Unterlagen.', 'Sekunde, ich blätter mal in deinen Briefen.', 'Gute Frage, ich guck kurz nach.', 'Warte, das such ich dir raus.', 'Einen Moment, ich schau mal rein.'],
        nachdenken: ['Hm, lass mich kurz überlegen.', 'Gute Frage! Moment.', 'Oh, da denk ich kurz drüber nach.', 'Sekunde, ich sortier kurz meine Gedanken.', 'Moment mal, gleich.'],
        gefuehl: ['Ich hör dir zu.', 'Danke, dass du mir das erzählst.', 'Das klingt nicht leicht. Moment.', 'Ich bin für dich da.', 'Lass uns kurz darüber reden.'],
        krise: ['Ich bin da. Einen Moment.', 'Ich hör dir zu. Einen Moment.', 'Danke, dass du es mir sagst. Ich bin da.'],
        app: ['Klar, ich zeig’s dir!', 'Gern, das ist ganz einfach.', 'Ah, gute Frage, pass auf.', 'Kein Problem, ich erklär’s dir.', 'Na klar, schau mal.'],
        erinnern: ['Moment, lass mich kurz überlegen, was du mir erzählt hast.', 'Warte, das hattest du mir doch gesagt.', 'Sekunde, ich kram kurz in meinem Gedächtnis.', 'Hm, Moment, gleich hab ich es.', 'Gute Frage, lass mich kurz nachdenken.'] },
  en: { unterlagen: ['One sec, let me check your documents.', 'Hang on, I will flip through your letters.', 'Good question, let me look that up.', 'Wait, let me dig that out for you.', 'Just a moment, let me take a look.'],
        nachdenken: ['Hmm, let me think for a second.', 'Good question! One moment.', 'Oh, let me think about that.', 'Give me a second to sort my thoughts.', 'Hold on, almost there.'],
        gefuehl: ['I am listening.', 'Thank you for telling me.', 'That sounds hard. One moment.', 'I am here for you.', 'Let us talk about it for a moment.'],
        krise: ['I am here. One moment.', 'I am listening. One moment.', 'Thank you for telling me. I am here.'],
        app: ['Sure, let me show you!', 'Happy to, it is easy.', 'Good question, here is how.', 'No problem, I will explain.', 'Of course, take a look.'],
        erinnern: ['One sec, let me remember what you told me.', 'Wait, you mentioned that before.', 'Let me dig through my memory for a second.', 'Hmm, hang on, I have got it in a second.', 'Good question, let me think back.'] },
  fr: { unterlagen: ['Une seconde, je regarde tes documents.', 'Attends, je feuillette tes lettres.', 'Bonne question, je vérifie vite.', 'Attends, je te retrouve ça.', 'Un instant, je jette un œil.'],
        nachdenken: ['Hm, laisse-moi réfléchir une seconde.', 'Bonne question ! Un instant.', 'Oh, je réfléchis deux secondes.', 'Attends, je rassemble mes idées.', 'Un moment, j’y suis presque.'],
        gefuehl: ['Je t’écoute.', 'Merci de me le dire.', 'Ça n’a pas l’air facile. Un instant.', 'Je suis là pour toi.', 'Parlons-en un peu.'],
        krise: ['Je suis là. Un instant.', 'Je t’écoute. Un instant.', 'Merci de me le dire. Je suis là.'],
        app: ['Bien sûr, je te montre !', 'Avec plaisir, c’est tout simple.', 'Bonne question, regarde.', 'Pas de souci, je t’explique.', 'Bien sûr, regarde bien.'],
        erinnern: ['Une seconde, je repense à ce que tu m’as dit.', 'Attends, tu me l’avais dit, non ?', 'Je fouille un peu dans ma mémoire.', 'Hm, attends, ça me revient.', 'Bonne question, laisse-moi me souvenir.'] },
  tr: { unterlagen: ['Bir saniye, belgelerine bakıyorum.', 'Dur, raporlarına bir göz atayım.', 'Güzel soru, hemen bakıyorum.', 'Bekle, bunu senin için bulayım.', 'Bir dakika, kayıtlarına bakayım.'],
        nachdenken: ['Hmm, bir saniye düşüneyim.', 'Güzel soru! Bir saniye.', 'Bunu biraz düşüneyim.', 'Bir saniye, düşüncelerimi toparlayayım.', 'Dur, neredeyse tamam.'],
        gefuehl: ['Seni dinliyorum.', 'Bunu bana anlattığın için teşekkürler.', 'Kolay değil gibi. Bir saniye.', 'Senin için buradayım.', 'Gel, biraz konuşalım.'],
        krise: ['Buradayım. Bir saniye.', 'Seni dinliyorum. Bir saniye.', 'Bana söylediğin için teşekkürler. Buradayım.'],
        app: ['Tabii, hemen göstereyim!', 'Seve seve, çok kolay.', 'Güzel soru, bak şöyle.', 'Sorun değil, anlatayım.', 'Elbette, şuna bak.'],
        erinnern: ['Bir saniye, bana ne anlattığını hatırlayayım.', 'Dur, bunu bana söylemiştin, değil mi?', 'Hafızamı biraz yoklayayım.', 'Hmm, bekle, hemen aklıma gelecek.', 'Güzel soru, bir hatırlayayım.'] },
  ar: { unterlagen: ['ثانية، سألقي نظرة على مستنداتك.', 'لحظة، سأتصفح تقاريرك الطبية.', 'سؤال جيد، سأتحقق بسرعة.', 'انتظر، سأبحث لك عن ذلك.', 'لحظة واحدة، سألقي نظرة.'],
        nachdenken: ['امم، دعني أفكر لحظة.', 'سؤال جيد! لحظة.', 'دعني أفكر في ذلك قليلًا.', 'ثانية، أرتب أفكاري.', 'لحظة، أوشكت على الانتهاء.'],
        gefuehl: ['أنا أسمعك.', 'شكرًا لأنك أخبرتني.', 'يبدو أن الأمر ليس سهلًا. لحظة.', 'أنا هنا من أجلك.', 'دعنا نتحدث عن ذلك قليلًا.'],
        krise: ['أنا هنا. لحظة.', 'أنا أسمعك. لحظة.', 'شكرًا لأنك أخبرتني. أنا هنا.'],
        app: ['طبعًا، سأريك!', 'بكل سرور، الأمر سهل.', 'سؤال جيد، انظر.', 'لا مشكلة، سأشرح لك.', 'بالتأكيد، انظر معي.'],
        erinnern: ['لحظة، دعني أتذكر ما أخبرتني به.', 'انتظر، لقد أخبرتني بذلك من قبل.', 'دعني أبحث في ذاكرتي لحظة.', 'امم، لحظة، سأتذكر حالًا.', 'سؤال جيد، دعني أتذكر.'] },
};
const SPRACHE_STANDARD = 'de';
// ---------- Krise (Nutzerentscheid 28.11.2026, Team prüft) ----------
// Nur bei KLAREN Anzeichen (nicht bei bloßem Verdacht). Zwei Arten:
//   seelisch    (Suizidalität, schwere Depression, seelisches Trauma) → TelefonSeelsorge 116 123 + Notruf 112
//   koerperlich (schwere körperliche Erkrankung oder Verletzung)      → ärztlicher Bereitschaftsdienst 116 117 + Notruf 112
// Nummern und Texte: Nutzerentscheid 28.11.2026, Team prüft. Verhalten in der Antwort steht in prompt/gespraech.md.
const KRISEN_NUMMERN = {
  seelisch: { nummer: '116 123', name: { de: 'TelefonSeelsorge (rund um die Uhr, kostenlos)', en: 'TelefonSeelsorge crisis line (24/7, free)', fr: 'TelefonSeelsorge, écoute (24 h/24, gratuit)', tr: 'TelefonSeelsorge kriz hattı (7/24, ücretsiz)', ar: 'خط الدعم النفسي TelefonSeelsorge (على مدار الساعة، مجانًا)' } },
  koerperlich: { nummer: '116 117', name: { de: 'Ärztlicher Bereitschaftsdienst', en: 'On-call medical service', fr: 'Médecin de garde', tr: 'Nöbetçi doktor hizmeti', ar: 'خدمة الطبيب المناوب' } },
};
const NOTRUF_TEXT = { de: 'Notruf / Rettungsdienst', en: 'Emergency / ambulance', fr: 'Urgences / ambulance', tr: 'Acil çağrı / ambulans', ar: 'الطوارئ / الإسعاف' };
const HILFE_SATZ = {
  seelisch: { de: 'Du bist nicht allein. Hier bekommst du sofort Hilfe – rund um die Uhr.', en: 'You are not alone. You can get help right away, day and night.',
    fr: 'Tu n’es pas seul·e. Tu peux obtenir de l’aide tout de suite, jour et nuit.', tr: 'Yalnız değilsin. Gece gündüz hemen yardım alabilirsin.', ar: 'لست وحدك. يمكنك الحصول على المساعدة فورًا، ليلًا ونهارًا.' },
  koerperlich: { de: 'Das klingt ernst. Hier bekommst du schnell ärztliche Hilfe.', en: 'That sounds serious. Here you can get medical help quickly.',
    fr: 'Ça a l’air sérieux. Ici, tu peux obtenir rapidement une aide médicale.', tr: 'Bu ciddi görünüyor. Burada hızlıca tıbbi yardım alabilirsin.', ar: 'يبدو هذا خطيرًا. هنا يمكنك الحصول على مساعدة طبية بسرعة.' },
};
// Wake-Word-Hinweis (iOS spricht ihn einmal pro Gerät/Nutzer, wenn mitano. zum ersten Mal in den Ruhemodus ginge).
const WAKEWORD_HINWEIS = {
  de: 'Übrigens: Wenn du eine Weile nichts sagst, ruh ich mich kurz aus. Sag einfach „mitano“, dann bin ich sofort wieder da.',
  en: 'By the way: if you don’t say anything for a while, I take a little rest. Just say “mitano” and I’m right back.',
  fr: 'Au fait : si tu ne dis rien pendant un moment, je me repose un peu. Dis simplement « mitano » et je reviens tout de suite.',
  tr: 'Bu arada: Bir süre bir şey söylemezsen biraz dinlenirim. Sadece „mitano“ de, hemen geri gelirim.',
  ar: 'بالمناسبة: إذا لم تقل شيئًا لفترة، أرتاح قليلًا. قل فقط «ميتانو» وسأعود فورًا.',
};
// Persönliche Begrüßung beim Verbinden (organisatorisch; {n} = Name aus dem Gedächtnis-Steckbrief).
const BEGRUESSUNG = {
  de: { name: ['Hey {n}, schön, dass du da bist! Was liegt an?', 'Hallo {n}! Schön, dich zu sehen. Wie kann ich dir helfen?', 'Hey {n}, da bist du ja! Was kann ich für dich tun?'],
        ohne: ['Hey, schön, dass du da bist! Ich bin mitano. Wie darf ich dich nennen?', 'Hallo! Ich bin mitano, dein Begleiter. Wie heißt du denn?'] },
  en: { name: ['Hey {n}, great to see you! What’s up?', 'Hi {n}! Nice to see you. How can I help?', 'Hey {n}, there you are! What can I do for you?'],
        ohne: ['Hey, great to see you! I’m mitano. What should I call you?', 'Hi! I’m mitano, your companion. What’s your name?'] },
  fr: { name: ['Salut {n}, content de te voir ! Qu’est-ce qui t’amène ?', 'Coucou {n} ! Comment je peux t’aider ?', 'Salut {n}, te voilà ! Je peux faire quoi pour toi ?'],
        ohne: ['Salut, content de te voir ! Je suis mitano. Comment je peux t’appeler ?', 'Coucou ! Je suis mitano, ton compagnon. Tu t’appelles comment ?'] },
  tr: { name: ['Selam {n}, iyi ki geldin! Neler oluyor?', 'Merhaba {n}! Seni görmek güzel. Nasıl yardımcı olabilirim?', 'Hey {n}, işte buradasın! Senin için ne yapabilirim?'],
        ohne: ['Selam, iyi ki geldin! Ben mitano. Sana nasıl hitap edeyim?', 'Merhaba! Ben mitano, yol arkadaşın. Adın ne?'] },
  ar: { name: ['أهلًا {n}، سعيد برؤيتك! ماذا لديك اليوم؟', 'مرحبًا {n}! كيف يمكنني مساعدتك؟', 'أهلًا {n}، ها أنت ذا! ماذا أستطيع أن أفعل لك؟'],
        ohne: ['أهلًا، سعيد بوجودك! أنا ميتانو. بماذا أناديك؟', 'مرحبًا! أنا ميتانو، رفيقك. ما اسمك؟'] },
};
function begruessung(sprache, name) {
  const b = BEGRUESSUNG[sprache] || BEGRUESSUNG.de;
  const liste = name ? b.name : b.ohne;
  return liste[crypto.randomInt(liste.length)].replace('{n}', name || '');
}
const KRISEN_ARTEN = ['seelisch', 'koerperlich'];
function krisenHilfe(art, sprache) {
  const a = KRISEN_ARTEN.includes(art) ? art : 'seelisch';
  const s = NOTRUF_TEXT[sprache] ? sprache : 'de';
  const k = KRISEN_NUMMERN[a];
  return { art: a, text: HILFE_SATZ[a][s], nummern: [{ nummer: k.nummer, name: k.name[s] }, { nummer: '112', name: NOTRUF_TEXT[s] }] };
}
// Technischer Hinweis an Claude im Krisenfall (Verhaltensregeln stehen im Prompt prompt/gespraech.md, vom Team).
function krisenHinweis(art) {
  const k = KRISEN_NUMMERN[art] || KRISEN_NUMMERN.seelisch;
  return `Technischer Hinweis: Die Nachricht enthält klare Anzeichen für eine ${art === 'koerperlich' ? 'schwere körperliche Notlage' : 'seelische Krise'}. Die App zeigt gerade zusätzlich eine Hilfekarte mit den Telefonnummern ${k.nummer} (${k.name.de}) und 112 (${NOTRUF_TEXT.de}) zum Antippen. Kein Witz in dieser Antwort.`;
}
// Schneller Stichwort-Vorfilter (Absicherung, falls Haiku zu langsam ist): nur EINDEUTIGE Formulierungen.
const KRISE_SEELISCH_RE = new RegExp([
  'suizid', 'selbstmord', 'mich umbringen', 'mich (selbst )?töten', 'mir das leben nehmen', 'will nicht mehr leben', 'nicht mehr leben will', 'will sterben', 'sterben will', 'lebensmüde',
  'ritze mich', 'verletze mich selbst', 'wurde vergewaltigt', 'bin vergewaltigt',
  'suicid', 'kill myself', 'end my life', 'ending my life', 'want to die', "don't want to live", 'dont want to live', 'hurt myself on purpose', 'cutting myself', 'i was raped',
  'me tuer', 'me suicider', 'envie de mourir', 'veux mourir', 'mettre fin à mes jours', 'j’ai été violée', "j'ai été violée",
  'intihar', 'kendimi öldür', 'ölmek istiyorum', 'yaşamak istemiyorum', 'kendime zarar veriyorum', 'tecavüze uğradım',
  'انتحار', 'أقتل نفسي', 'اقتل نفسي', 'أريد أن أموت', 'لا أريد أن أعيش', 'أؤذي نفسي', 'تعرضت للاغتصاب',
].join('|'), 'i');
const KRISE_KOERPER_RE = new RegExp([
  'starke brustschmerzen', 'brustschmerzen und atemnot', 'bekomme keine luft', 'kann nicht (mehr )?atmen', 'ich blute stark', 'hört nicht auf zu bluten', 'war bewusstlos', 'bin zusammengebrochen', 'gesicht hängt', 'kann (den arm|meinen arm) nicht (mehr )?bewegen',
  'severe chest pain', "can't breathe", 'cannot breathe', 'bleeding heavily', 'passed out',
  'douleur thoracique intense', 'je n’arrive pas à respirer', "je n'arrive pas à respirer", 'je saigne beaucoup',
  'şiddetli göğüs ağrısı', 'nefes alamıyorum', 'çok kanıyor',
  'ألم شديد في الصدر', 'لا أستطيع التنفس', 'أنزف بشدة',
].join('|'), 'i');
function kriseStichwort(t) { return KRISE_SEELISCH_RE.test(t) ? 'seelisch' : KRISE_KOERPER_RE.test(t) ? 'koerperlich' : null; }
// Gefühle, Sorgen, Ängste, Traurigkeit, Einsamkeit → Claude (einfühlsam, ohne Witz).
const GEFUEHL_RE = new RegExp([
  'angst', 'ängst', 'sorge', 'traurig', 'einsam', 'allein', 'deprimiert', 'depressiv', 'niedergeschlagen', 'verzweifelt', 'überfordert', 'gestresst', 'weinen', 'hoffnungslos',
  'fühle mich (schlecht|leer|mies|elend)', "mir geht('s| es) (schlecht|nicht gut|mies)", 'kummer', 'panik',
  'anxious', 'afraid', 'scared', 'worried', 'sad', 'lonely', 'alone', 'depressed', 'hopeless', 'overwhelmed', 'stressed', 'crying', 'i feel (bad|empty|down)', 'panic',
  'peur', 'angoiss', 'inquiet', 'triste', 'seul', 'déprim', 'désesp', 'stressé', 'pleur', 'je me sens (mal|vide)',
  'korku', 'endişe', 'kaygı', 'üzgün', 'yalnız', 'depresyon', 'umutsuz', 'stres', 'ağlı', 'kendimi kötü',
  'خائف', 'خوف', 'قلق', 'حزين', 'وحيد', 'اكتئاب', 'يائس', 'متوتر', 'أبكي',
].join('|'), 'i');
// Zweite Krisen-Prüfung per Claude Haiku (S/K/N, ohne Nachdenken). Liefert 'seelisch'|'koerperlich'|'nein', bei Fehler/Zeitlimit null.
const KRISE_ANWEISUNG = 'Du prüfst nur, ob eine Nachricht an eine Gesundheits-App KLARE Anzeichen einer Krise enthält – nicht bei bloßem Verdacht, Sorgen, Traurigkeit oder Fragen zu früheren Erkrankungen. Antworte mit genau einem Buchstaben: S = klare Anzeichen für Suizidalität, schwere Depression oder ein seelisches Trauma; K = klare Anzeichen für eine akute schwere körperliche Erkrankung oder Verletzung; N = nichts davon.';
async function pruefeKrise(nachricht, timeoutMs = 2500) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const model = wegModell();
    const body = { model, max_tokens: 2, system: KRISE_ANWEISUNG, messages: [{ role: 'user', content: `<nachricht>\n${String(nachricht).slice(0, 1000)}\n</nachricht>` }] };
    if (!/^claude-(haiku|sonnet)-4-5/.test(model)) body.thinking = { type: 'disabled' };
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return null;
    if (d?.stop_reason === 'refusal') return 'seelisch';   // heikle Nachricht → lieber Hilfe anbieten
    const c = ((d?.content || []).find((b) => b.type === 'text')?.text || '').trim().toUpperCase().charAt(0);
    return c === 'S' ? 'seelisch' : c === 'K' ? 'koerperlich' : 'nein';
  } catch { return null; } finally { clearTimeout(timer); }
}
// Krise für diese Nachricht? Vorfilter, Merker aus der Weiche, Hintergrund-Prüfung (wartet höchstens bis KRISE_WARTE_MS nach der Weiche).
const KRISE_WARTE_MS = 1500;
// warten=false (keine Gefühlswörter): nicht bremsen; ein spätes „J“ setzt nur noch krise/hilfe im fertig-Ereignis.
// Liefert 'seelisch' | 'koerperlich' | null.
async function istKrise(roh, nachricht, warten = true) {
  const sw = kriseStichwort(nachricht);
  if (sw) return sw;
  const k = roh.kriseVorlauf; roh.kriseVorlauf = null;
  if (!k || k.nachricht !== nachricht) return null;
  roh.kriseLetzte = k;
  // Demo-Fix 28.11.: körperliche Krise NUR über eindeutige Stichworte (oben), nicht per KI-Einschätzung –
  // Fragen zur Vorgeschichte („Wann war ich wegen dem Herzinfarkt im Krankenhaus?“) lösten sonst Fehlalarm aus.
  const art = (x) => (x === 'seelisch' ? x : null);
  if (k.ergebnis !== undefined || !warten) return art(k.ergebnis);
  const rest = Math.max(0, k.start + KRISE_WARTE_MS - Date.now());
  return art(await Promise.race([k.p, new Promise((ok) => setTimeout(() => ok(null), rest))]));
}
// Auswahl der Avatare: id = unsere eigene Kennung (nicht die D-ID-ID). Bilder per HEAD geprüft (200).
// Stimmen: Microsoft „MultilingualNeural“ (per GET /tts/voices geprüft) – jede spricht Deutsch, Englisch und Französisch.
const AVATARE = [
  { id: 'emma', name: 'Emma', bild: DID_BILD_BASIS + 'Emma_f/v1_image.jpeg', stimme: 'de-DE-SeraphinaMultilingualNeural',
    beschreibung: 'Ruhig und freundlich, spricht klar und deutlich.' },
  { id: 'noelle', name: 'Noelle', bild: DID_BILD_BASIS + 'Noelle_f/v1_image.jpeg', stimme: 'fr-FR-VivienneMultilingualNeural',
    beschreibung: 'Herzlich und geduldig, mit warmer Stimme.' },
  { id: 'william', name: 'William', bild: DID_BILD_BASIS + 'William_m/v1_image.jpeg', stimme: 'en-US-AndrewMultilingualNeural',
    beschreibung: 'Gelassen und zugewandt, mit ruhiger Stimme.' },
  { id: 'eric', name: 'Eric', bild: DID_BILD_BASIS + 'Eric_m/v1_image.jpeg', stimme: 'de-DE-FlorianMultilingualNeural',
    beschreibung: 'Sachlich und freundlich, erklärt Schritt für Schritt.' },
].map((a) => ({ ...a, sprachen: Object.keys(SPRACHEN) }));
const AVATAR_STANDARD = 'emma';
const DID_BILD = AVATARE[0].bild;
const DID_STIMME = AVATARE[0].stimme;
const DID_ANBIETER = 'D-ID (Israel/USA, Server in den USA – nicht DSGVO-konform)';
const DID_TIMEOUT_MS = 30 * 1000;
const MAX_BODY_AVATAR = 32 * 1024;   // reicht für die Verbindungsdaten (SDP)
const MAX_SPRECHTEXT = 5000;

// ---------- D-ID-Studio-Agents (MIT eigener KI von D-ID) ----------
// Pro Profilsprache ein fertiger Agent aus studio.d-id.com: DID_AGENT_DE, DID_AGENT_EN, DID_AGENT_FR.
// Ist für die Profilsprache einer gesetzt, antwortet D-ID selbst (Wissensbasis + Anweisung im Agent).
const PROFILE_FILE = path.join(__dirname, 'lokal', 'profile.json');   // { nutzername: { sprache } }
const STUDIO_CACHE_MS = 10 * 60 * 1000;
// Bild-Hosts der Studio-Agents (beide in der CSP img-src erlaubt): „talk“-Presenter bzw. „clip“-Presenter.
const STUDIO_BILD_HOSTS = ['https://create-images-results.d-id.com/', 'https://clips-presenters.d-id.com/'];
const STUDIO_VIDEO_HOST = 'https://agents-results.d-id.com/';          // in der CSP (media-src) erlaubt
// Zwei Techniken bei D-ID: „talk“/„clip“-Avatare laufen über Agents Streams V1 (WebRTC, unser Server spricht),
// „image“-/„expressive“-Avatare (z. B. „mitano.“) nur über Agents Streams V2 = LiveKit-Raum. Bei V2 verbindet sich
// der Browser mit Adresse + Kurzzeit-Schlüssel der Sitzung und schickt die Sätze selbst (Thema „did.speak“).
// Der D-ID-API-Schlüssel bleibt immer auf dem Server.
const DID_V2_TYPEN = ['image', 'expressive'];
const didTechnik = (agent) => (DID_V2_TYPEN.includes(agent?.presenter?.type) ? 'v2' : 'v1');
// LiveKit-Adresse der V2-Sitzung muss zur CSP passen (connect-src wss://*.livekit.cloud).
const LIVEKIT_HOST = /^wss:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.livekit\.cloud\/?$/i;

// ---------- Gespräch mit dem Avatar ----------
// Ablauf (Ausbaustufe 2): Nachricht → Claude (Systemprompt + Unterlagen als Kontext + Verlauf der Sitzung)
// → Antwort ohne Markdown → der D-ID-Avatar spricht sie über avatarSprichText (D-ID nur Bild und Stimme).
const GESPRAECH_PROMPT_FILE = path.join(__dirname, 'prompt', 'gespraech.md');
const MAX_NACHRICHT = 2000;
const MAX_VERLAUF = 20;                  // so viele Beiträge (Nutzer + Avatar) bekommt Claude als Gedächtnis
const MAX_PROTOKOLL = 200;               // Protokoll der Sitzung (nur Arbeitsspeicher)
const MAX_BODY_GESPRAECH = 64 * 1024;
// App-Anweisung: ersetzt prompt/gespraech.md für ALLE Nutzer, ändern dürfen nur Admins (Inhalt wird nie geloggt).
const GESPRAECH_ANWEISUNG_FILE = path.join(__dirname, 'lokal', 'gespraech-anweisung.json');   // { text, geaendertAm }
const MAX_SYSTEMPROMPT = 20000;
const MODELL_STANDARD = 'claude-haiku-5-5';            // Standard fürs Übersetzen, wenn ANTHROPIC_MODEL leer ist
const GESPRAECH_MODELL_STANDARD = 'claude-sonnet-5-5'; // Standard fürs Gespräch, wenn ANTHROPIC_MODEL_GESPRAECH leer ist
// Obergrenze inkl. Denkanteil. NICHT zu klein wählen: Claude Sonnet 5.5 denkt trotz „between_tools“ manchmal vorher nach
// (gemessen 28.11.2026: 450 Denk-Tokens bei „Erzähl mir alles genau“ → bei max_tokens 450 gar kein Text). Die Kürze steuern
// Stil-Hinweis (rag.js) und Satzbremse. Per .env GESPRAECH_MAX_TOKENS änderbar.
const GESPRAECH_MAX_TOKENS = Math.min(8192, Math.max(1024, Number(process.env.GESPRAECH_MAX_TOKENS) || 2048));
// Weiche Satzbremse (Nutzerwunsch „lockerer“, 28.11.2026): Im Claude-Weg spricht mitano. höchstens SATZBREMSE Sätze.
// Kommen mindestens zwei weitere, werden sie als „offener Rest“ der Sitzung gemerkt und mitano. fragt nach
// (Satz aus dem Prompt). Sagt die Person „ja/gern/erzähl mehr“, wird der Rest ohne neuen Claude-Aufruf gesprochen.
// 0 = aus (per .env SATZBREMSE). Quellen bleiben vollständig.
const SATZBREMSE = Math.max(0, Math.min(20, Number.isFinite(Number(process.env.SATZBREMSE)) && process.env.SATZBREMSE !== '' ? Number(process.env.SATZBREMSE) : 4));
const OFFENER_REST_MS = 10 * 60 * 1000;
const MEHR_ANGEBOT = {
  de: 'Soll ich dir mehr dazu erzählen?', en: 'Shall I tell you more about it?', fr: 'Tu veux que je t’en dise plus ?',
  tr: 'Sana biraz daha anlatayım mı?', ar: 'هل تريد أن أخبرك بالمزيد؟',
};
// Kurze Zustimmung auf das Angebot (alle App-Sprachen). Nur kurze Antworten zählen (sonst ist es eine neue Frage).
const MEHR_JA_RE = /^(ja|jaa|jo|gern|gerne|klar|bitte|ok|okay|sicher|unbedingt|weiter|mehr|erzähl|erzaehl|na klar|yes|yeah|yep|sure|please|go on|tell me more|oui|volontiers|bien sûr|vas-y|evet|olur|tabii|tabi|anlat|devam|نعم|أجل|اجل|طبعا|بالتأكيد|تفضل)(\b|[\s,.!?،؟]|$)/i;
function willMehr(nachricht) {
  const t = String(nachricht || '').trim().toLowerCase();
  return t.split(/\s+/).length <= 6 && MEHR_JA_RE.test(t) && !/\b(nein|nö|no|non|hayır|لا)\b/i.test(t);
}
const GESPRAECH_TIMEOUT_MS = 45 * 1000;
const GESPRAECH_ANBIETER = 'Anthropic (USA) + D-ID (Israel/USA) – nicht DSGVO-konform';
// Satzweises Sprechen: erster Satz sofort an D-ID, Rest danach. Nur einschalten, wenn per Test bestätigt ist,
// dass D-ID zwei aufeinanderfolgende Sprechaufträge nacheinander abspielt (nicht abbricht).
// Getestet am 27.11.2026 mit einem Clip-Avatar: zweiter Auftrag startet erst nach Ende des ersten → eingeschaltet.
const SATZWEISE_SPRECHEN = true;
// Ältere Modelle kennen output_config.effort nicht (würde 400 liefern).
const OHNE_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];

// ---------- Kontext: hochgeladene Unterlagen (nur synthetische Test-Patienten) ----------
const KONTEXT_DIR = path.join(__dirname, 'lokal', 'kontext');   // pro Nutzer eine Datei <nutzer>.json
const MAX_BODY_KONTEXT = 12 * 1024 * 1024;   // 12 MB nur für POST /api/kontext
const MAX_KONTEXT_ZEICHEN = 150000;          // alle Unterlagen zusammen
const MAX_KONTEXT_DOKUMENTE = 50;
const MAX_BILD_BYTES = 5 * 1024 * 1024;      // Grenze der Anthropic-API für Bilder
const BILD_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ABSCHRIFT_TIMEOUT_MS = 120 * 1000;
// Rein technische Anweisung fürs Abschreiben von Fotos/Scans/PDFs (keine medizinischen Inhalte).
const ABSCHRIFT_ANWEISUNG = 'Transkribiere den Text vollständig und wortgetreu. Gib nur den abgeschriebenen Text aus, ohne Einleitung oder Kommentar.';

// ---------- Nutzerspeicher (Datei, nur Passwort-Hashes) ----------
let users = [];

function loadUsers() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
}
function saveUsers() {
  schreibeJsonAtomar(USERS_FILE, users, 2);
}
async function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(pw, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
async function checkPassword(user, pw) {
  // Auch bei unbekanntem Nutzer rechnen, damit die Antwortzeit nichts verrät.
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
  const actual = await scrypt(pw, salt, 64);
  return crypto.timingSafeEqual(actual, expected) && !!user;
}
const validName = (n) => typeof n === 'string' && /^[a-z0-9._-]{3,32}$/.test(n);
const validRole = (r) => r === 'admin' || r === 'arzt';

// Entwicklungsphase: Passwörter von ADMIN_USER/DEMO_USER aus .env übernehmen, wenn sie vom gespeicherten Hash abweichen
// (wie werkzeuge/passwoerter-setzen.js). Mindestens 4 Zeichen. Es wird nie ein Passwort geloggt.
const MIN_PW_ENV = 4;
async function passwoerterAusEnv() {
  const paare = [
    { name: process.env.ADMIN_USER, pw: process.env.ADMIN_PASSWORD, rolle: 'admin' },
    { name: process.env.DEMO_USER, pw: process.env.DEMO_PASSWORD, rolle: 'admin' },   // demo hat für die Demo Admin-Rechte
  ];
  let geaendert = 0;
  for (const { name, pw, rolle } of paare) {
    if (!name) continue;
    const n = String(name).toLowerCase().trim();
    if (!validName(n) || !pw || pw.startsWith('hier-') || pw.length < MIN_PW_ENV || pw.length > 200) continue;
    const vorhanden = users.find((u) => u.username === n);
    if (vorhanden && await checkPassword(vorhanden, pw)) continue;
    if (vorhanden) Object.assign(vorhanden, await hashPassword(pw));
    else users.push({ username: n, role: rolle, ...(await hashPassword(pw)) });
    geaendert++;
    console.log(`Passwort aus .env übernommen: ${n}`);
  }
  if (geaendert) saveUsers();
}

async function seedAdmin() {
  loadUsers();
  await passwoerterAusEnv();
  if (users.length) return;
  const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
  if (!validName(ADMIN_USER) || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < MIN_PW) {
    console.log('Hinweis: Noch kein Nutzer vorhanden. Trage ADMIN_USER und ADMIN_PASSWORD (mind. 10 Zeichen) in .env ein und starte neu.');
    return;
  }
  users.push({ username: ADMIN_USER, role: 'admin', ...(await hashPassword(ADMIN_PASSWORD)) });
  saveUsers();
  console.log('Erster Administrator wurde angelegt.');
}

// ---------- Sitzungen ----------
// Arbeitsspeicher; zusätzlich lokal/sitzungen.json (nur Prüfsumme des Tokens, Name, Rolle, Zeiten – keine Inhalte),
// damit ein Neustart des Servers (z. B. durch den Wächter) niemanden abmeldet. Avatar-Verbindung und
// Gesprächsprotokoll bleiben nur im Arbeitsspeicher. Schlüssel der Map = SHA-256 des Cookie-Tokens.
const sessions = new Map();
const SESSIONS_FILE = path.join(__dirname, 'lokal', 'sitzungen.json');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const sitzungAbgelaufen = (s, now = Date.now()) => now - s.last > IDLE_MS || now - s.created > MAX_MS;
let sitzungenGeaendert = false;
function speichereSitzungen() {
  sitzungenGeaendert = false;
  const liste = [...sessions].map(([h, s]) => ({ h, username: s.username, role: s.role, created: s.created, last: s.last }));
  try { schreibeJsonAtomar(SESSIONS_FILE, liste); } catch (e) { console.log(`Sitzungen: Speichern fehlgeschlagen (${fehlerArt(e)}).`); }
}
function ladeSitzungen() {
  let liste = [];
  try { liste = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(liste)) return;
  const now = Date.now();
  for (const x of liste) {
    if (!x || typeof x.h !== 'string' || !/^[a-f0-9]{64}$/.test(x.h)) continue;
    const u = users.find((n) => n.username === x.username);
    if (!u || !Number.isFinite(x.created) || !Number.isFinite(x.last)) continue;
    const s = { username: u.username, role: u.role, created: x.created, last: x.last, consent: true };
    if (!sitzungAbgelaufen(s, now)) sessions.set(x.h, s);
  }
  if (sessions.size) console.log(`Sitzungen: ${sessions.size} Anmeldung(en) nach Neustart übernommen.`);
}
function beendeSitzung(key) {
  const s = sessions.get(key);
  if (!s) return;
  stoppeAvatar(s);
  sessions.delete(key);
  sitzungenGeaendert = true;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// Liefert eine Kopie der Sitzung; sess.token ist der Schlüssel in „sessions“ (Prüfsumme, nicht das Cookie selbst).
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const key = tokenHash(token);
  const s = sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (sitzungAbgelaufen(s, now)) { beendeSitzung(key); return null; }
  if (now - s.last > 30 * 1000) sitzungenGeaendert = true;   // „zuletzt aktiv“ höchstens alle 30 s neu speichern
  s.last = now;
  return { token: key, ...s };
}
function startSession(req, res, user) {
  // Eine noch offene alte Sitzung desselben Browsers schließen (samt Avatar-Verbindung).
  const alt = parseCookies(req).sid;
  if (alt) beendeSitzung(tokenHash(alt));
  // Höchstens 20 gleichzeitige Anmeldungen je Nutzer (älteste fällt weg) – sonst wächst die Liste endlos.
  const eigene = [...sessions].filter(([, s]) => s.username === user.username).sort((x, y) => x[1].created - y[1].created);
  for (const [k] of eigene.slice(0, Math.max(0, eigene.length - 19))) beendeSitzung(k);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(tokenHash(token), { username: user.username, role: user.role, created: now, last: now, consent: true });
  speichereSitzungen();
  setCookie(req, res, token, MAX_MS / 1000);
}
// Echte Client-Adresse: Über den Cloudflare-Tunnel kommt jede Anfrage von 127.0.0.1. Nur dann (Verbindung vom
// eigenen Rechner) werden CF-Connecting-IP bzw. X-Forwarded-For übernommen – sonst ließen sie sich fälschen.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const vonLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress);
function clientIp(req) {
  const direkt = req.socket.remoteAddress || 'unbekannt';
  if (!LOOPBACK.has(direkt)) return direkt;
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (net.isIP(cf)) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (net.isIP(xff)) return xff;
  return direkt;
}
// Läuft die Seite für den Browser über https (Tunnel)? Dann bekommt das Cookie das Secure-Merkmal.
function istHttps(req) {
  if (req.socket.encrypted) return true;
  if (!vonLoopback(req)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
    || /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || ''));
}
function setCookie(req, res, value, maxAge) {
  // Lax statt Strict: Safari/iOS verliert Strict-Cookies, wenn die Seite von außen geöffnet wird.
  // Schutz vor fremden Seiten bleibt: Änderungen brauchen zusätzlich X-Requested-With + JSON.
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${istHttps(req) ? '; Secure' : ''}`);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (sitzungAbgelaufen(s, now)) beendeSitzung(k);
  if (sitzungenGeaendert) speichereSitzungen();
}, 60 * 1000).unref();

// ---------- Bremse gegen Raten von Passwörtern und Überlastung ----------
// Getrennte Töpfe je Client-Adresse. Freihändiges Gespräch erzeugt pro Satz mehrere Anfragen (Weiche, Gespräch,
// Protokoll, Diagnose-Codes) – deshalb ist der allgemeine Topf großzügig, teure Aufrufe (Claude/D-ID) knapper.
const fails = new Map();   // "ip|nutzer" -> { count, until }
const hits = new Map();    // "topf|ip" -> { count, reset }
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const LIMITS = {
  api: 300,          // alle API-Anfragen pro Minute
  ki: 60,            // Claude-/D-ID-Aufrufe pro Minute (Weiche, Gespräch, Sprechen, Übersetzen, Hochladen)
  avatarStart: 10,   // neue Avatar-Verbindungen pro Minute (D-ID-Guthaben)
  login: 20,         // Anmeldeversuche pro Minute
};
const KI_ROUTEN = new Set(['POST /api/gespraech/weg', 'POST /api/avatar/gespraech', 'POST /api/avatar/sprechen', 'POST /api/uebersetzen',
  'POST /api/kontext', 'POST /api/unterlagen', 'POST /api/zeitstrahl/aktualisieren']);
// Liefert 0 (erlaubt) oder die Wartezeit in Sekunden.
function tooManyRequests(topf, ip) {
  const now = Date.now();
  const k = topf + '|' + ip;
  let h = hits.get(k);
  if (!h || now > h.reset) { h = { count: 0, reset: now + 60 * 1000 }; hits.set(k, h); }
  return ++h.count > LIMITS[topf] ? Math.max(1, Math.ceil((h.reset - now) / 1000)) : 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  for (const [k, f] of fails) if ((f.until && now > f.until) || (!f.until && now - (f.zeit || 0) > LOCK_MS)) fails.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- Hilfsfunktionen ----------
function securityHeaders(res, nonce) {
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
    `img-src 'self' data: https://create-images-results.d-id.com https://clips-presenters.d-id.com; media-src 'self' https://agents-results.d-id.com; ` +
    // LiveKit (D-ID Agents V2): Signalisierung per wss, Regionsliste per https – nur LiveKit-Cloud-Adressen.
    `connect-src 'self' wss://*.livekit.cloud https://*.livekit.cloud; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJson(res, status, obj) {
  // Antwort schon begonnen (z. B. Ereignisstrom) oder Verbindung weg: nur noch sauber beenden.
  if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req, maxBody = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const zuGross = () => Object.assign(new Error('zu gross'), { status: 413, meldung: 'Die Anfrage ist zu groß.' });
    // Angekündigte Größe zuerst prüfen, dann gar nicht erst lesen.
    if (Number(req.headers['content-length']) > maxBody) { req.pause(); return reject(zuGross()); }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) { req.removeAllListeners('data'); req.pause(); reject(zuGross()); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('kein Objekt');
        resolve(v);
      } catch { reject(Object.assign(new Error('kein JSON'), { status: 400, meldung: 'Die Anfrage war kein gültiges JSON.' })); }
    });
    req.on('error', reject);
    // Bricht der Browser beim Hochladen ab, nicht ewig warten (sonst bleibt der Puffer im Speicher).
    req.on('close', () => { if (!req.complete) reject(Object.assign(new Error('abgebrochen'), { status: 400, meldung: 'Die Übertragung wurde abgebrochen.' })); });
  });
}

// ---------- KI: System-Prompt und Anthropic-Aufruf ----------
// Fehler mit kurzer deutscher Meldung für die Oberfläche.
const kiFehler = (status, meldung) => Object.assign(new Error('ki'), { status, meldung });
// Teil einer Adresse dekodieren; kaputte %-Folgen → 400 statt interner Fehler.
function dekodiere(teil) {
  try { return decodeURIComponent(teil); } catch { throw kiFehler(400, 'Ungültige Adresse.'); }
}

// Rein technische Aufgabe (keine medizinischen Regeln): Form der Übersetzung in einfache Sprache.
const UEBERSETZEN_AUFGABE = 'Technische Aufgabe: Du bekommst einen Text (Modus „einfach“). Erkläre der Person, um deren Unterlage es geht, in einfacher Sprache und in Du-Form, was in dem folgenden Text steht. Sprich sie direkt an, auch wenn der Text an eine Ärztin oder einen Arzt gerichtet ist, und gib keine Anrede oder Grußformel des Originals wieder. Kurze Sätze, Fachwörter erklärt, nichts Wichtiges weglassen und nichts hinzufügen. Hier darfst du Absätze verwenden, weil der Text gelesen wird. Felder: text = die einfache Fassung; nicht_uebersetzbare_stellen = Stellen, die du nicht sicher übertragen kannst (sonst leer); hinweise = kurze Hinweise für die Person (sonst leer).';
function ladeSystemPrompt() {
  // Bei jeder Anfrage frisch lesen, damit Änderungen ohne Neustart wirken.
  let inhalt = '';
  try { inhalt = fs.readFileSync(PROMPT_FILE, 'utf8'); } catch { inhalt = ''; }
  if (!inhalt.trim() || inhalt.includes(PROMPT_MARKE)) {
    // Entscheid Koordinator 28.11.2026: Solange prompt/system.md nur Platzhalter ist, gilt der vom Team freigegebene
    // Gesprächs-Prompt (prompt/gespraech.md bzw. App-Anweisung) plus eine rein technische Aufgabenzeile.
    const g = gespraechStand();
    if (!g.systemprompt || !g.systemprompt.trim()) throw kiFehler(503, 'Das Übersetzen geht gerade leider nicht. Bitte versuch es später noch einmal.');
    return `${g.systemprompt}\n\n${UEBERSETZEN_AUFGABE}`;
  }
  return inhalt;
}

function kiZugang() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  // Nur schnelle Modelle: ohne Eintrag (oder mit Platzhalter) gilt claude-haiku-5-5.
  const m = (process.env.ANTHROPIC_MODEL || '').trim();
  const model = m && !m.startsWith('hier-') ? m : MODELL_STANDARD;
  if (!key || key.startsWith('hier-')) throw kiFehler(503, 'Der API-Schlüssel fehlt noch. Bitte ANTHROPIC_API_KEY in .env eintragen und den Server neu starten.');
  return { key, model };
}

function meldungZuStatus(status) {
  if (status === 401 || status === 403) return 'Der API-Schlüssel wurde abgelehnt. Bitte ANTHROPIC_API_KEY in .env prüfen.';
  if (status === 404) return 'Das KI-Modell ist unbekannt. Bitte ANTHROPIC_MODEL in .env prüfen.';
  if (status === 413) return 'Der Text ist für den KI-Dienst zu lang.';
  if (status === 429) return 'Der KI-Dienst ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.';
  if (status >= 500) return 'Der KI-Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.';
  return 'Der KI-Dienst hat die Anfrage nicht angenommen.';
}

const nurTexte = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []);

async function frageKi(systemPrompt, modus, text) {
  const { key, model } = kiZugang();
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2026-10-21',
  };
  const body = {
    model,
    max_tokens: 16000,
    system: systemPrompt,
    // Nur technische Trennung von Modus und Text – die Regeln stehen in prompt/system.md.
    messages: [{ role: 'user', content: `<modus>${modus}</modus>\n<text>\n${text}\n</text>` }],
    output_config: { format: { type: 'json_schema', schema: ANTWORT_SCHEMA } },
  };
  // Tempo: ohne Angabe denkt das Modell mit „high“ (~50 s für einen Brief). „low“ braucht ~13 s (per .env UEBERSETZEN_EFFORT änderbar).
  const effort = String(process.env.UEBERSETZEN_EFFORT || 'low').trim();
  if (['low', 'medium', 'high'].includes(effort) && !/haiku-4-5|sonnet-4-5/.test(model)) body.output_config.effort = effort;
  // Lehnt das Modell ab, springt serverseitig ein passendes Ersatzmodell ein (nur wo unterstützt).
  if (FALLBACK_MODELLE.includes(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KI_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    daten = await r.json().catch(() => null);
  } catch (e) {
    if (e.name === 'AbortError') throw kiFehler(504, 'Die KI hat zu lange gebraucht. Bitte einen kürzeren Text versuchen.');
    throw kiFehler(502, 'Keine Verbindung zum KI-Dienst.');
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    // Nur Status und Fehlerart loggen – nie Schlüssel, Text oder Antwortinhalt.
    console.log(`KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw kiFehler(502, meldungZuStatus(r.status));
  }
  if (daten?.stop_reason === 'refusal') throw kiFehler(502, 'Die KI hat diese Anfrage abgelehnt.');
  if (daten?.stop_reason === 'max_tokens') throw kiFehler(502, 'Die Antwort der KI war zu lang und wurde abgeschnitten. Bitte einen kürzeren Text versuchen.');

  const block = (daten?.content || []).find((b) => b.type === 'text');
  let ergebnis;
  try { ergebnis = JSON.parse(block?.text || ''); } catch { ergebnis = null; }
  if (!ergebnis || typeof ergebnis.text !== 'string') throw kiFehler(502, 'Die Antwort der KI war unvollständig. Bitte erneut versuchen.');

  return {
    text: ergebnis.text,
    nicht_uebersetzbare_stellen: nurTexte(ergebnis.nicht_uebersetzbare_stellen),
    hinweise: nurTexte(ergebnis.hinweise),
  };
}

// Atomar schreiben wie saveUsers: erst temporäre Datei (nur für den Besitzer lesbar), dann umbenennen.
// Parallele Schreibzugriffe: Alle Lese-Ändern-Schreiben-Abläufe auf Dateien in lokal/ laufen synchron (ohne await
// dazwischen) – Node führt sie nacheinander aus, eine Warteschlange je Datei ist deshalb nicht nötig. Der zufällige
// Name der temporären Datei verhindert, dass sich zwei Vorgänge die Zwischendatei teilen.
function schreibeJsonAtomar(datei, daten, einzug) {
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  const tmp = datei + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(daten, null, einzug), { mode: 0o600 });
    fs.renameSync(tmp, datei);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// ---------- Gespräch: App-Anweisung (lokal/gespraech-anweisung.json, gilt für alle) ----------
// Der Inhalt kommt von einem Admin über die App. Er wird nie geloggt.
let appAnweisung = '';
function ladeAppAnweisung() {
  try {
    const t = JSON.parse(fs.readFileSync(GESPRAECH_ANWEISUNG_FILE, 'utf8'))?.text;
    appAnweisung = typeof t === 'string' ? t : '';
  } catch { appAnweisung = ''; }
}
function setzeAppAnweisung(text) {
  appAnweisung = text || '';
  if (appAnweisung) schreibeJsonAtomar(GESPRAECH_ANWEISUNG_FILE, { text: appAnweisung, geaendertAm: new Date().toISOString() });
  else fs.rmSync(GESPRAECH_ANWEISUNG_FILE, { force: true });
}

// ---------- Wissensspeicher: Test-Patienten (rag.js, lokal/patienten/<id>/) ----------
// Nur synthetische Arztbriefe. Ist einem Nutzer ein Test-Patient zugeordnet, beantwortet der Avatar Fragen aus dessen
// Unterlagen mit Quellenangabe (rag.antworteMitQuellen). Standard: ADMIN_USER und DEMO_USER → p2.
// Zuordnung in lokal/patient-zuordnung.json ({ nutzer: patientId|null }). Inhalte werden nie geloggt.
const ZUORDNUNG_FILE = path.join(__dirname, 'lokal', 'patient-zuordnung.json');
const STANDARD_PATIENT = 'p2';
const STANDARD_PATIENT_NAME = 'Testpatient Max Mustermann';
// Suchbegriff-Erweiterung per Claude (Haiku) vor der Suche: RAG_ERWEITERN=an|aus, Zeitlimit RAG_ERWEITERN_MS.
// Gemessen am 27.11.2026: Haiku braucht 1,0–1,8 s → mit „an“ verschiebt sich der erste Satz um bis zu RAG_ERWEITERN_MS.
const RAG_ERWEITERN_STANDARD = 'aus';
const RAG_ERWEITERN_MS = Math.min(4000, Math.max(300, Number(process.env.RAG_ERWEITERN_MS) || 1200));
const ragErweitern = () => (String(process.env.RAG_ERWEITERN || RAG_ERWEITERN_STANDARD).trim().toLowerCase() === 'an');
let zuordnung = {};
function ladeZuordnung() {
  try { const z = JSON.parse(fs.readFileSync(ZUORDNUNG_FILE, 'utf8')); zuordnung = z && typeof z === 'object' ? z : {}; } catch { zuordnung = {}; }
}
function setzeZuordnung(nutzer, patientId) {
  if (patientId === undefined) delete zuordnung[nutzer]; else zuordnung[nutzer] = patientId;
  schreibeJsonAtomar(ZUORDNUNG_FILE, zuordnung);
}
const standardNutzer = () => [process.env.ADMIN_USER, process.env.DEMO_USER].filter(Boolean).map((n) => String(n).toLowerCase().trim());
function patientExistiert(id) {
  try { rag.ladePatient(id); return true; } catch { return false; }
}
// Welcher Test-Patient gehört zu diesem Nutzer? null = keiner (dann normales Gespräch mit hochgeladenen Unterlagen).
function patientVon(nutzer) {
  // Einzige Quelle: patientendaten.js (ADMIN_USER → p2, DEMO_USER → p-demo). lokal/patient-zuordnung.json gilt nur
  // noch als ausdrückliche Admin-Ausnahme für weitere Nutzer (PUT /api/admin/zuordnung), nie für admin/demo.
  const std = pd.patientFuerNutzer(nutzer);
  const id = std || (Object.hasOwn(zuordnung, nutzer) ? zuordnung[nutzer] : null);
  return id && patientExistiert(id) ? id : null;
}
const patientSicht = (p) => p && {
  id: p.id, name: p.name, geburtsjahr: p.geburtsjahr ?? null, hinweis: p.hinweis || null,
  dokumente: p.dokumente.map(({ docId, titel, datum, typ, zeichen }) => ({ docId, titel, datum, typ, zeichen })),
};
// Quellen für die Oberfläche (zum Antippen): start/ende = Zeichenposition im Volltext (GET /api/patient/dokument/:docId).
const quellenSicht = (quellen) => (quellen || []).map(({ nr, docId, titel, datum, abschnitt, zitat, start, ende }) => ({ nr, docId, titel, datum, abschnitt, zitat, start, ende }));
// Beim Start: Test-Patient p2 aus daten/grascco anlegen, falls er fehlt.
function standardPatientAnlegen() {
  if (patientExistiert(STANDARD_PATIENT)) return;
  try {
    const r = rag.importiereAusOrdner({ patientId: STANDARD_PATIENT, name: STANDARD_PATIENT_NAME, dateien: rag.waehleBeispielbriefe({ anzahl: 15 }) });
    console.log(`Wissensspeicher: Test-Patient ${STANDARD_PATIENT} angelegt (${r.neu} Briefe, ${r.chunks} Abschnitte).`);
  } catch (e) {
    console.log(`Wissensspeicher: Test-Patient ${STANDARD_PATIENT} konnte nicht angelegt werden (${e.meldung || 'Fehler'}).`);
  }
}
// Antwort aus den Unterlagen des Test-Patienten (mit Quellen). beiSatz(satz) bekommt jeden fertigen Satz ohne Zitatmarker.
// Rückgabe null, wenn kein Patient/keine Unterlagen da sind → dann normales Gespräch.
async function ragAntwort({ patientId, nachricht, verlauf, stand, sprache, beiSatz, fokusDocs = [], gedaechtnis = null, signal, begriffe = null }) {
  if (!patientId || !stand.bereit) return null;
  let gesprochen = false;
  try {
    // Gedächtnis (Fakten aus früheren Gesprächen + Unterlagen) als technischer Zusatz an den Systemprompt.
    const gb = gedaechtnis || gedaechtnisFuer(patientId, nachricht);
    // Brücke Gedächtnis → Suche: Briefe, aus denen passende Gedächtnis-Angaben stammen, bekommen Vorrang (max. 2).
    const ausGedaechtnis = [...new Set((gb.fakten || []).filter((f) => f.quelleTyp === 'dokument' && f.docId).map((f) => f.docId))].slice(0, 2);
    const r = await rag.antworteMitQuellen({
      patientId, frage: nachricht, verlauf, signal, begriffe,
      systemprompt: stand.systemprompt, appWissen: appWissen(),
      nachCache: [gb.text, (SPRACHEN[sprache] || SPRACHEN[SPRACHE_STANDARD]).anweisung],
      model: stand.modell, streaming: true,
      beiSatz: beiSatz ? (satz) => { gesprochen = true; beiSatz(satz); } : undefined,
      erweitern: ragErweitern(), erweiterungTimeoutMs: RAG_ERWEITERN_MS, fokusDocs: [...new Set([...fokusDocs, ...ausGedaechtnis])],
    });
    return { ...r, gedaechtnisFakten: gb.fakten };
  } catch (e) {
    if (e.status === 404 && !gesprochen) return null;   // keine Unterlagen gespeichert
    throw e;
  }
}

// ---------- Kontext: Unterlagen pro Nutzer (lokal/kontext/<nutzer>.json) ----------
// Erlaubt laut CLAUDE.md nur für synthetische Test-Patienten. Inhalte und Dateinamen werden nie geloggt.
function kontextDatei(nutzer) {
  if (!validName(nutzer)) throw kiFehler(400, 'Ungültiger Nutzername.');
  return path.join(KONTEXT_DIR, nutzer + '.json');
}
function ladeKontext(nutzer) {
  try {
    const d = JSON.parse(fs.readFileSync(kontextDatei(nutzer), 'utf8'));
    return Array.isArray(d?.dokumente) ? d.dokumente.filter((x) => x && typeof x.text === 'string') : [];
  } catch { return []; }
}
function speichereKontext(nutzer, dokumente) {
  if (dokumente.length) schreibeJsonAtomar(kontextDatei(nutzer), { dokumente });
  else fs.rmSync(kontextDatei(nutzer), { force: true });
}
// Hochgeladene Unterlagen beim Löschen auch aus dem Wissensspeicher des Test-Patienten entfernen.
function entferneAusPatient(nutzer, dokumente) {
  const patientId = patientVon(nutzer);
  if (!patientId) return;
  for (const d of dokumente) {
    if (!d.patientDocId) continue;
    try { pd.loeschen(patientId, d.patientDocId); } catch {}   // Text, Index, Seitenbilder, Zeitstrahl
    dokumentEntfernt(patientId, d.patientDocId);
  }
}
// Konsistenz (Nutzerwunsch 28.11.2026): Ein gelöschtes Dokument verschwindet aus ALLEM, was daraus abgeleitet wurde.
// pd.loeschen() erledigt Text, Suchindex, Seitenbilder und Zeitstrahl; hier der Rest: Gedächtnis-Fakten, Ansage,
// „ja“-Fokus, gemerkte Quellen/offener Rest/vorgestartete Antwort aller Sitzungen dieses Patienten, Dashboard-Ableitungen.
function dokumentEntfernt(patientId, docId) {
  try { gd.vergissDokument(patientId, docId); } catch {}
  ANSAGEN.delete(`${patientId}:${docId}`);
  for (const s of sessions.values()) {
    if (!s || patientVon(s.username) !== patientId) continue;
    roh_quellenVergessen(s, docId);
    if (s.ansageFokus?.docId === docId) s.ansageFokus = null;
    if (s.offenerRest && (s.offenerRest.quellen || []).some((q) => q.docId === docId)) s.offenerRest = null;
    if (s.spekulation) verwirfSpekulation(s);
  }
  if (dashboard && typeof dashboard.vergissDokument === 'function') {
    Promise.resolve().then(() => dashboard.vergissDokument(patientId, docId)).catch(() => console.log('Dashboard: Ableitungen nicht gelöscht.'));
  }
}
// Gelöschtes Dokument nicht mehr als „zuletzt zitiert“ bevorzugen.
function roh_quellenVergessen(roh, docId) {
  if (roh && Array.isArray(roh.letzteQuellenDocs)) roh.letzteQuellenDocs = roh.letzteQuellenDocs.filter((d) => d !== docId);
}
const vorschau = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 160);
const kontextSicht = (d) => ({ id: d.id, name: d.name, typ: d.typ, zeichen: d.text.length, vorschau: vorschau(d.text), erstelltAm: d.erstelltAm });
function kontextListe(nutzer) {
  const dokumente = ladeKontext(nutzer);
  return { dokumente: dokumente.map(kontextSicht), gesamtZeichen: dokumente.reduce((n, d) => n + d.text.length, 0), maxZeichen: MAX_KONTEXT_ZEICHEN };
}
function sichererName(n) {
  const s = typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
  return s || 'Dokument';
}
// Base64 prüfen; ein versehentlich mitgeschicktes "data:...;base64,"-Präfix wird toleriert.
function leseBase64(inhalt) {
  if (typeof inhalt !== 'string') return null;
  const b64 = inhalt.replace(/^data:[^,]{0,100},/, '').replace(/\s+/g, '');
  if (!b64 || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return { b64, bytes: Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) };
}

// Foto/Scan (Bild) oder PDF per Claude abschreiben lassen (Modell ANTHROPIC_MODEL).
async function schreibeAb(typ, mime, b64) {
  const { key, model } = kiZugang();
  const quelle = typ === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  const body = {
    model, max_tokens: 16000,
    messages: [{ role: 'user', content: [quelle, { type: 'text', text: ABSCHRIFT_ANWEISUNG }] }],
  };
  if (!OHNE_EFFORT.includes(model)) body.output_config = { effort: 'low' };
  if (FALLBACK_MODELLE.includes(model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ABSCHRIFT_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    daten = await r.json().catch(() => null);
  } catch (e) {
    throw kiFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Das Abschreiben hat zu lange gedauert. Bitte weniger Seiten auf einmal hochladen.' : 'Keine Verbindung zum KI-Dienst.');
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    console.log(`Kontext: Abschrift fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw kiFehler(502, r.status === 400 ? 'Die Datei konnte nicht gelesen werden. Ist es ein gültiges Bild bzw. PDF?' : meldungZuStatus(r.status));
  }
  if (daten?.stop_reason === 'refusal') throw kiFehler(502, 'Die KI hat das Abschreiben abgelehnt.');
  if (daten?.stop_reason === 'max_tokens') throw kiFehler(413, 'Das Dokument ist zu lang zum Abschreiben. Bitte in kleineren Teilen hochladen.');
  const text = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw kiFehler(502, 'Im Dokument wurde kein Text gefunden.');
  return text;
}

// ---------- Unterlagen des Test-Patienten (patientendaten.js) ----------
// Neue Unterlage: Text direkt, Bild/PDF/Seiten zuerst per Claude abschreiben. Seitenbilder (nur JPEG) werden gespeichert.
// Danach den Zeitstrahl für dieses Dokument im Hintergrund berechnen (Fehler still, nur Status im Log).
const MAX_BODY_UNTERLAGEN = 30 * 1024 * 1024;   // bis zu 20 Scan-Seiten als JPEG
const MAX_SEITEN = 20;
// Speicher schonen: höchstens MAX_UPLOADS große Uploads gleichzeitig (der ganze Inhalt liegt beim Lesen im
// Arbeitsspeicher) und je Scan höchstens ABSCHRIFT_PARALLEL Seiten gleichzeitig bei Claude.
const MAX_UPLOADS = 3;
const ABSCHRIFT_PARALLEL = 3;
let laufendeUploads = 0;
async function mitUploadPlatz(fn) {
  if (laufendeUploads >= MAX_UPLOADS) throw kiFehler(503, 'Gerade werden schon andere Unterlagen verarbeitet. Bitte in einer Minute erneut versuchen.');
  laufendeUploads++;
  try { return await fn(); } finally { laufendeUploads--; }
}
async function nacheinanderBegrenzt(liste, n, fn) {
  const erg = new Array(liste.length);
  let i = 0;
  const arbeiter = async () => { while (i < liste.length) { const k = i++; erg[k] = await fn(liste[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, arbeiter));
  return erg;
}
// ---------- Gedächtnis (gedaechtnis.js) – Lernen immer im Hintergrund, nie vor der Antwort warten ----------
function gedaechtnisFuer(patientId, frage) {
  if (!patientId) return { text: '', fakten: [] };
  try { return gd.kontextFuerFrage({ patientId, frage }); } catch { return { text: '', fakten: [] }; }
}
// Termine/Medikamentenplan aus dem Dashboard als Zusatz für Claude (nur bei passenden Fragen, nur aus Cache).
const DASHBOARD_FRAGE_RE = /termin|wann (muss|soll) ich|kontrolle|nachsorge|medikamentenplan|medikament|tablette|nehme ich|einnehm|dosis|appointment|check-?up|medication|pill|rendez-vous|médicament|randevu|ilaç|موعد|دواء|أدوية/i;
async function dashboardKontext(patientId, frage) {
  if (!dashboard || typeof dashboard.kontextFuerClaude !== 'function' || !patientId || !DASHBOARD_FRAGE_RE.test(String(frage || ''))) return '';
  try {
    const t = await Promise.race([Promise.resolve(dashboard.kontextFuerClaude(patientId, { frage })), new Promise((ok) => setTimeout(() => ok(''), 300))]);
    return typeof t === 'string' && t.trim() ? `Termine und Medikamentenplan der Person (aus der App):\n${t.trim().slice(0, 1500)}` : '';
  } catch { return ''; }
}
function gedaechtnisQuellen(fakten, antwort) {
  try { return fakten && fakten.length ? gd.quellenAusAntwort({ fakten, antwort }) : []; } catch { return []; }
}
function lerneImHintergrund(patientId, nutzerText, avatarText, sprache) {
  if (!patientId || !nutzerText) return;
  if (kriseStichwort(nutzerText)) return;   // Krisen-Inhalte nie automatisch ins Gedächtnis
  if (istAppFrage(nutzerText)) return;   // App-Hilfe enthält keine Angaben über die Person
  gd.lerneAusGespraech({ patientId, nutzerText, avatarText: String(avatarText || '').replace(UNTERBROCHEN_MARKE, ''), sprache }).catch(() => {});
}
function dokumentLernenImHintergrund(patientId, docId) {
  gd.lerneAusDokument({ patientId, docId }).catch((e) => console.log(`Gedächtnis: Dokument nicht ausgewertet (${e.status || 'Fehler'}).`));
}
// ---------- Sofort-Lesen (Runde 2): kurze Ansage nach dem Hochladen ----------
// Claude Haiku schreibt 2 Sätze (Du-Form, Profilsprache): worum es geht + Angebot, es zu erklären. Nur im Arbeitsspeicher.
const ANSAGEN = new Map();   // `${patientId}:${docId}` → { status, text, sprache, seit }
const ANSAGE_SPRACHE = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', tr: 'Türkisch', ar: 'Arabisch' };
const ANSAGE_FRAGE = { de: 'Soll ich es dir erklären?', en: 'Shall I explain it to you?', fr: 'Tu veux que je te l’explique ?', tr: 'Sana açıklayayım mı?', ar: 'هل تريد أن أشرحه لك؟' };
function ansageImHintergrund(patientId, docId, sprache = 'de') {
  const schluessel = `${patientId}:${docId}`;
  ANSAGEN.set(schluessel, { status: 'laeuft', text: '', sprache, seit: Date.now() });
  if (ANSAGEN.size > 200) ANSAGEN.delete(ANSAGEN.keys().next().value);
  const fertig = (status, text) => {
    // Dokument inzwischen gelöscht? Dann keine Ansage mehr anlegen.
    let da = false;
    try { da = rag.ladePatient(patientId).dokumente.some((d) => d.docId === docId); } catch {}
    if (da || status === 'laeuft') ANSAGEN.set(schluessel, { status, text, sprache, seit: Date.now() }); else ANSAGEN.delete(schluessel);
  };
  (async () => {
    const key = process.env.ANTHROPIC_API_KEY || '';
    if (!key) return fertig('fehler', '');
    const dok = rag.ladeDokument(patientId, docId);
    // Rein technische Aufgabe (keine medizinischen Regeln): kurze, lockere Ankündigung, keine Bewertung.
    const system = `Du bist mitano., ein lockerer, herzlicher digitaler Begleiter in einer Gesundheits-App (nur erfundene Testdaten). Die Person hat gerade eine Unterlage hochgeladen. Schreib genau zwei kurze Sätze auf ${ANSAGE_SPRACHE[sprache] || 'Deutsch'} in Du-Form, zum Vorlesen (keine Aufzählung, keine Emojis): Satz 1 sagt locker, was das für eine Unterlage ist und worum es grob geht (Art, Datum falls genannt, Hauptthema – ohne Bewertung). Satz 2 lautet sinngemäß: „${ANSAGE_FRAGE[sprache] || ANSAGE_FRAGE.de}“`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const body = { model: wegModell(), max_tokens: 250, system, messages: [{ role: 'user', content: `<unterlage titel="${attrSicher(dok.titel || '')}" datum="${dok.datum || ''}">\n${String(dok.text || '').slice(0, 8000)}\n</unterlage>` }] };
      if (!/^claude-(haiku|sonnet)-4-5/.test(body.model)) body.thinking = { type: 'disabled' };
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.stop_reason === 'refusal') { console.log(`Ansage: nicht erstellt (Status ${r.status}).`); return fertig('fehler', ''); }
      const text = ohneMarkdown((d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')).slice(0, 600);
      fertig(text ? 'fertig' : 'fehler', text);
      console.log('Ansage: fertig.');
    } catch { fertig('fehler', ''); } finally { clearTimeout(timer); }
  })().catch(() => fertig('fehler', ''));
}
function zeitstrahlImHintergrund(patientId, docId) {
  pd.extrahiereEreignisse(patientId, docId).then(
    () => console.log('Zeitstrahl: ein Dokument ausgewertet.'),
    (e) => console.log(`Zeitstrahl: Auswertung fehlgeschlagen (${e.status || 'Fehler'}).`));
}
async function legeUnterlageAn(patientId, b, sprache = 'de') {
  const art = b.art;
  if (!['text', 'bild', 'pdf', 'seiten'].includes(art)) throw kiFehler(400, 'Unbekannte Art von Unterlage. Erlaubt sind Text, Foto, PDF und Scan.');
  const titel = typeof b.titel === 'string' ? b.titel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '';
  let text, typ, bilder = [];
  if (art === 'text') {
    if (typeof b.text !== 'string' || !b.text.trim()) throw kiFehler(400, 'Der Text ist leer.');
    text = b.text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_KONTEXT_ZEICHEN) throw kiFehler(413, 'Der Text ist zu lang.');
    typ = 'upload';
  } else if (art === 'seiten') {
    const seiten = Array.isArray(b.seiten) ? b.seiten : [];
    if (!seiten.length) throw kiFehler(400, 'Es wurde keine Seite gescannt.');
    if (seiten.length > MAX_SEITEN) throw kiFehler(413, `Höchstens ${MAX_SEITEN} Seiten auf einmal.`);
    const daten = seiten.map(leseBase64);
    if (daten.some((d) => !d || !d.b64.startsWith('/9j/'))) throw kiFehler(400, 'Scan-Seiten bitte als JPEG senden.');
    if (daten.some((d) => d.bytes > MAX_BILD_BYTES)) throw kiFehler(413, 'Eine Seite ist zu groß (höchstens 5 MB).');
    const texte = await nacheinanderBegrenzt(daten, ABSCHRIFT_PARALLEL, (d) => schreibeAb('bild', 'image/jpeg', d.b64));
    text = texte.join('\n\n');
    typ = 'scan';
    bilder = daten.map((d) => d.b64);
  } else {
    const d = leseBase64(b.inhalt);
    if (!d) throw kiFehler(400, 'Die Datei kam nicht richtig an (kein gültiges Base64). Bitte erneut versuchen.');
    if (art === 'pdf') {
      if (!d.b64.startsWith('JVBER')) throw kiFehler(400, 'Die Datei ist kein PDF.');
      text = await schreibeAb('pdf', 'application/pdf', d.b64);
      typ = 'upload';
    } else {
      const mime = String(b.mime || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(b.mime || '').toLowerCase();
      if (!BILD_MIMES.includes(mime)) throw kiFehler(400, 'Dieses Bildformat geht nicht. Erlaubt sind JPEG, PNG, GIF und WebP.');
      if (d.bytes > MAX_BILD_BYTES) throw kiFehler(413, 'Das Bild ist zu groß (höchstens 5 MB).');
      text = await schreibeAb('bild', mime, d.b64);
      typ = 'foto';
      if (mime === 'image/jpeg') bilder = [d.b64];
    }
  }
  const r = pd.neu(patientId, { titel, text, typ, bilder });
  if (!r.doppelt) { zeitstrahlImHintergrund(patientId, r.dokument.docId); dokumentLernenImHintergrund(patientId, r.dokument.docId); ansageImHintergrund(patientId, r.dokument.docId, sprache); }
  console.log(`Unterlagen: ${r.doppelt ? 'doppelt' : 'neu'} (${art}, ${bilder.length} Seitenbild(er), ${text.length} Zeichen).`);
  return r;
}

// ---------- Profil: Sprache pro Nutzer (lokal/profile.json) ----------
let profile = new Map();
function ladeProfile() {
  try {
    const roh = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    profile = new Map(Object.entries(roh || {}).filter(([, p]) => p && typeof p === 'object'));
  } catch { profile = new Map(); }
}
function speichereProfile() {
  schreibeJsonAtomar(PROFILE_FILE, Object.fromEntries(profile), 2);
}
function profilSprache(nutzer) {
  const s = profile.get(nutzer)?.sprache;
  return typeof s === 'string' && Object.hasOwn(SPRACHEN, s) ? s : SPRACHE_STANDARD;
}
function entferneProfil(nutzer) {
  if (profile.delete(nutzer)) speichereProfile();
}
// Studio-Avatare (D-ID-Agents) und ihre Sprachen aus .env:
//   DID_AVATARE=agentId:de+en+fr,agentId:de   (gesetzt → nur diese Liste, Reihenfolge = Anzeige)
//   Gruppe (EIN Avatar, pro Sprache ein eigener D-ID-Agent): name=agentId:sprache, z. B.
//   DID_AVATARE=mitano=v2_agt_A:de,mitano=v2_agt_B:en  → in der App ein Avatar „mitano“; die Sprache wird beim
//   Start mitgegeben (POST /api/avatar/start { avatarId:'mitano', sprache:'en' }) und wählt den Agenten.
//   Stimm-Varianten (gleiches Bild/Anweisung, andere Agent-Stimme; gilt für did.speak UND den nativen Weg lk.chat):
//   gruppe.stimme=agentId:sprache, z. B. mitano.harper=v2_agt_X:de → in den Einstellungen wählbar (Profilfeld „stimme“).
//   Einträge ohne „.stimme“ sind die Standard-Stimme der Gruppe.
//   DID_AVATAR_STANDARD=agentId               (optional, sonst der erste passende)
//   sonst wie bisher: DID_AGENT_<SPRACHE> und DID_AGENTEN_<SPRACHE> (kommagetrennt), je nur diese Sprache.
const gueltigeAgentId = (v) => !!v && !v.startsWith('hier-') && /^[A-Za-z0-9_-]{3,64}$/.test(v);
const gueltigeGruppe = (v) => /^[a-z][a-z0-9-]{1,30}$/.test(v);
const gueltigeStimme = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(v);
// Beschreibung der Stimmen für die Einstellungen (Schlüssel = Stimmname aus der D-ID-voice_id, klein geschrieben).
const STIMMEN_INFO = {
  grant: { name: 'Grant', geschlecht: 'männlich', beschreibung: 'Ruhig und freundlich' },
  harper: { name: 'Harper', geschlecht: 'weiblich', beschreibung: 'Warm und einfühlsam' },
  mia: { name: 'Mia', geschlecht: 'weiblich', beschreibung: 'Jung und fröhlich' },
  klaus: { name: 'Klaus', geschlecht: 'männlich', beschreibung: 'Tief und gelassen' },
};
const stimmName = (voiceId) => (/^[a-z]{2}-[A-Z]{2}-([A-Za-z]+?)(?:Multilingual)?(?:Neural|:|$)/.exec(String(voiceId || ''))?.[1] || '').toLowerCase();
function studioAvatare() {
  const liste = [];
  const dazu = (id, sprachen, gruppe = null, stimme = null) => {
    if (!gueltigeAgentId(id) || !sprachen.length) return;
    const da = liste.find((a) => a.id === id);
    if (da) { for (const s of sprachen) if (!da.sprachen.includes(s)) da.sprachen.push(s); } else liste.push({ id, sprachen: [...sprachen], gruppe, stimme });
  };
  const roh = String(process.env.DID_AVATARE || '').trim();
  if (roh) {
    for (const eintrag of roh.split(',')) {
      let teil = eintrag.trim(), gruppe = null, stimme = null;
      const gl = teil.indexOf('=');
      if (gl > 0) {
        [gruppe, stimme = null] = teil.slice(0, gl).trim().toLowerCase().split('.');
        teil = teil.slice(gl + 1);
        if (!gueltigeGruppe(gruppe) || (stimme !== null && !gueltigeStimme(stimme))) continue;
      }
      const [id, spr = 'de'] = teil.trim().split(':');
      dazu((id || '').trim(), [...new Set(spr.split('+').map((x) => x.trim().toLowerCase()).filter((x) => Object.hasOwn(SPRACHEN, x)))], gruppe, stimme);
    }
  } else {
    for (const s of Object.keys(SPRACHEN)) {
      const S = s.toUpperCase();
      for (const id of [String(process.env['DID_AGENT_' + S] || ''), ...String(process.env['DID_AGENTEN_' + S] || '').split(',')]) dazu(id.trim(), [s]);
    }
  }
  return liste;
}
// Agent-IDs, die eine Sprache können (Reihenfolge wie konfiguriert).
function studioAgentIds(sprache) {
  return studioAvatare().filter((a) => a.sprachen.includes(sprache)).map((a) => a.id);
}
// Standard-Avatar für eine Sprache: DID_AVATAR_STANDARD, falls er die Sprache kann, sonst der erste (oder null).
function studioAgentId(sprache) {
  const ids = studioAgentIds(sprache);
  const std = String(process.env.DID_AVATAR_STANDARD || '').trim();
  return ids.includes(std) ? std : ids[0] || null;
}
// Gruppen (ein Avatar, mehrere Sprach-Agenten): { name: { sprachen:[…], agenten:{ sprache: agentId } } } in Reihenfolge.
function avatarGruppen() {
  const g = new Map();
  for (const a of studioAvatare()) {
    if (!a.gruppe) continue;
    if (!g.has(a.gruppe)) g.set(a.gruppe, { name: a.gruppe, sprachen: [], agenten: {}, stimmen: {} });
    const e = g.get(a.gruppe);
    if (a.stimme) {   // Stimm-Variante: { stimme: { sprache: agentId } }
      e.stimmen[a.stimme] = e.stimmen[a.stimme] || {};
      for (const s of a.sprachen) if (!e.stimmen[a.stimme][s]) e.stimmen[a.stimme][s] = a.id;
      continue;
    }
    for (const s of a.sprachen) if (!e.agenten[s]) { e.agenten[s] = a.id; e.sprachen.push(s); }
  }
  return g;
}
// Einmalige Einrichtung (Avatar + Sprache). ADMIN_USER ist ohne Eintrag schon eingerichtet (mitano, Deutsch);
// DEMO_USER wird bei jeder Anmeldung zurückgesetzt (Demo-Effekt, siehe POST /api/login).
const istNutzer = (nutzer, envName) => !!process.env[envName] && String(process.env[envName]).toLowerCase().trim() === nutzer;
function profilEingerichtet(nutzer) {
  const p = profile.get(nutzer) || {};
  if (typeof p.eingerichtet === 'boolean') return p.eingerichtet;
  return istNutzer(nutzer, 'ADMIN_USER');
}
function profilAvatar(nutzer) {
  const a = profile.get(nutzer)?.avatarId;
  if (typeof a === 'string' && /^[a-z0-9_-]{1,80}$/i.test(a)) return a;
  const g = [...avatarGruppen().keys()];
  return g[0] || null;
}
// Gewählte Stimme (Profil): 'standard' = Stimme der Standard-Agenten der Gruppe.
function profilStimme(nutzer) {
  const s = profile.get(nutzer)?.stimme;
  return gueltigeStimme(s) ? s : 'standard';
}
// Stimmen der Avatar-Gruppe in einer Sprache: Standard + Varianten (mit Name/Beschreibung aus STIMMEN_INFO).
async function stimmenListe(gruppe, sprache) {
  if (!gruppe || !gruppe.agenten[sprache]) return [];
  const eintraege = [['standard', gruppe.agenten[sprache]],
    ...Object.entries(gruppe.stimmen || {}).filter(([, a]) => a[sprache]).map(([k, a]) => [k, a[sprache]])];
  const erg = await Promise.allSettled(eintraege.map(([, id]) => studioAgent(id)));
  return eintraege.map(([k, id], i) => {
    const vid = erg[i].status === 'fulfilled' ? erg[i].value.presenter?.voice?.voice_id : null;
    const info = STIMMEN_INFO[k] || STIMMEN_INFO[stimmName(vid)] || {};
    return { id: k, name: info.name || (k === 'standard' ? 'Standard' : k), geschlecht: info.geschlecht || '', beschreibung: info.beschreibung || '' };
  });
}
function profilAntwort(nutzer) {
  return {
    stimme: profilStimme(nutzer),
    sprache: profilSprache(nutzer),
    avatarId: profilAvatar(nutzer),
    eingerichtet: profilEingerichtet(nutzer),
    sprachen: Object.entries(SPRACHEN).map(([id, s]) => ({ id, name: s.name, verfuegbar: !!studioAgentId(id) })),
  };
}

// ---------- Gespräch: welcher Prompt, welches Modell, Echo oder KI? ----------
// Reihenfolge (vom Team prüfbar):
//   1. App-Anweisung, die ein Admin in der App eingetragen hat           → quelle "app"
//   2. prompt/gespraech.md, wenn dort keine PLATZHALTER-Zeile mehr steht → quelle "datei"
//   3. sonst kein Prompt                                                  → quelle "keine" (Echo-Test)
// KI nur, wenn zusätzlich ANTHROPIC_API_KEY gesetzt ist. Sonst Echo-Test: der Avatar wiederholt nur,
// was er verstanden hat – keine KI, keine erfundenen Inhalte.
function gespraechModell() {
  const m = (process.env.ANTHROPIC_MODEL_GESPRAECH || '').trim();
  return m && !m.startsWith('hier-') ? m : GESPRAECH_MODELL_STANDARD;
}
function gespraechStand() {
  let datei = '';
  try { datei = fs.readFileSync(GESPRAECH_PROMPT_FILE, 'utf8'); } catch {}
  const dateiOk = !!datei.trim() && !datei.includes(PROMPT_MARKE);
  const quelle = appAnweisung ? 'app' : dateiOk ? 'datei' : 'keine';
  const systemprompt = appAnweisung || (dateiOk ? datei : '');
  const modell = gespraechModell();
  const key = process.env.ANTHROPIC_API_KEY || '';
  const keyOk = !!key && !key.startsWith('hier-');

  let grund = null;
  if (!keyOk) {
    grund = 'Echo-Test: Der Schlüssel für Claude (ANTHROPIC_API_KEY) fehlt noch in .env. Der Avatar wiederholt nur, was er verstanden hat.';
    if (quelle === 'keine') grund += ' Außerdem fehlt noch die Anweisung für den Avatar.';
  } else if (quelle === 'keine') {
    grund = 'Echo-Test: Es gibt noch keine Anweisung für den Avatar. Bitte in der App eintragen (oder prompt/gespraech.md füllen).';
  }
  return { systemprompt, quelle, modell, bereit: !grund, grund, maxLaenge: MAX_SYSTEMPROMPT };
}

// Verlauf in das Format der Anthropic-API bringen: beginnt mit "user", Rollen wechseln sich ab.
function baueNachrichten(verlauf, nachricht) {
  const liste = [];
  for (const v of [...verlauf, { rolle: 'nutzer', text: nachricht }]) {
    const role = v.rolle === 'avatar' ? 'assistant' : 'user';
    if (!liste.length && role !== 'user') continue;
    const letzte = liste[liste.length - 1];
    if (letzte && letzte.role === role) letzte.content += '\n' + v.text;
    else liste.push({ role, content: v.text });
  }
  return liste;
}

// Systemblöcke: Prompt, dann jedes Kontextdokument als eigener Block (mit Namen).
// Cache-Marke auf dem letzten stabilen Block → Prompt + Unterlagen werden von Anthropic zwischengespeichert,
// Folgefragen sind dadurch schneller und günstiger. Der rein technische Sprachblock („Antworte auf …“) steht
// dahinter, damit der Zwischenspeicher bei einem Sprachwechsel erhalten bleibt.
const attrSicher = (t) => t.replace(/[<>&"]/g, (z) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[z]);
function baueSystem(prompt, dokumente, sprache, gedaechtnisText = '') {
  const bloecke = [{ type: 'text', text: prompt }];
  const aw = appWissen();
  if (aw) bloecke.push({ type: 'text', text: aw });   // App-Handbuch, ändert sich selten → im Cache
  if (dokumente.length) {
    bloecke.push({ type: 'text', text: `Unterlagen der Patientin bzw. des Patienten (${dokumente.length} Dokument${dokumente.length === 1 ? '' : 'e'}):` });
    for (const d of dokumente) {
      bloecke.push({ type: 'text', text: `<dokument name="${attrSicher(d.name)}" typ="${d.typ}" hochgeladen="${d.erstelltAm}">\n${d.text}\n</dokument>` });
    }
  }
  bloecke[bloecke.length - 1].cache_control = { type: 'ephemeral' };
  if (gedaechtnisText) bloecke.push({ type: 'text', text: gedaechtnisText });   // nach dem Cache-Punkt, ändert sich je Frage
  if (sprache && SPRACHEN[sprache]) bloecke.push({ type: 'text', text: SPRACHEN[sprache].anweisung });
  return bloecke;
}

// Antwort wird vorgelesen: Markdown-Zeichen vorsichtshalber entfernen.
function ohneMarkdown(t) {
  return String(t)
    .replace(/```[a-z]*\n?|```/gi, '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')        // [Text](Link) → Text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                  // Überschriften
    .replace(/^\s*[-*+•]\s+/gm, '')                      // Aufzählungszeichen
    .replace(/^\s*>\s?/gm, '')                           // Zitate
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                  // fett
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')   // kursiv
    .replace(/[*#`|]/g, '')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')   // Emojis werden nicht vorgelesen
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Ende des ersten vollständigen Satzes finden (oder -1). Abkürzungen und Ordnungszahlen werden übersprungen.
const ABKUERZUNGEN = /(?:^|[\s.])(?:z|b|d|h|u|a|o|s|v|ca|bzw|ggf|evtl|inkl|etc|usw|vgl|dr|prof|nr|med|mg|ml|st|str|tbl|tabl|max|min|bspw|sog)\.$/i;
// Text in einzelne Sätze zerlegen (gleiche Regeln wie ersterSatzEnde).
function zerlegeSaetze(text) {
  const aus = []; let rest = String(text || ''), e;
  while ((e = ersterSatzEnde(rest)) > 0) { aus.push(rest.slice(0, e).trim()); rest = rest.slice(e); }
  if (rest.trim()) aus.push(rest.trim());
  return aus.filter(Boolean);
}
function ersterSatzEnde(text) {
  const re = /[.!?…]["“”»)]?(?=\s+\S)/g;
  let m;
  while ((m = re.exec(text))) {
    const ende = m.index + m[0].length;
    const vorne = text.slice(0, ende);
    if (vorne.trim().length < 25) continue;
    if (m[0][0] === '.' && (/\d\.$/.test(vorne.slice(0, m.index + 1)) || ABKUERZUNGEN.test(text.slice(0, m.index + 1)))) continue;
    return ende;
  }
  return -1;
}

// Server-Sent Events aus einem fetch-Antwortstrom lesen (ohne npm).
async function* sseEreignisse(body) {
  const dec = new TextDecoder();
  let puffer = '';
  for await (const stueck of body) {
    puffer += dec.decode(stueck, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = puffer.indexOf('\n\n')) >= 0) {
      const roh = puffer.slice(0, i);
      puffer = puffer.slice(i + 2);
      const daten = roh.split('\n').filter((z) => z.startsWith('data:')).map((z) => z.slice(5).trimStart()).join('\n');
      if (!daten) continue;
      try { yield JSON.parse(daten); } catch {}
    }
  }
}

// Gespräch mit Claude per Streaming. beiErstemSatz(satz) wird (falls übergeben) einmal aufgerufen,
// sobald der erste vollständige Satz da ist. jederSatz(satz) (falls übergeben) bekommt nacheinander JEDEN fertigen
// Satz (mind. 25 Zeichen, kurze Sätze werden mit dem nächsten gebündelt) und am Ende den Rest – für V2-Avatare,
// bei denen der Browser jeden Satz sofort an D-ID schickt. Keine Sampling-Parameter (bei API-Version 2026-10-21 verboten).
async function kiAntwortStream(system, messages, model, beiErstemSatz, jederSatz, abbruchSignal) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw kiFehler(503, 'Echo-Test: ANTHROPIC_API_KEY fehlt in .env.');
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  const body = { model, max_tokens: GESPRAECH_MAX_TOKENS, system, messages, stream: true };
  // Denken/Effort/Ersatzmodell wie im Unterlagen-Weg (rag.gespraechDenken; .env GESPRAECH_DENKEN, GESPRAECH_EFFORT,
  // GESPRAECH_FALLBACK). Standard: Sonnet 5.5 mit „between_tools“ (kein Vorab-Denken laut Doku) und effort "low" –
  // gemessen am 28.11.2026 die schnellste zulässige Einstellung bei gleicher Korrektheit.
  rag.gespraechDenken(model, body);
  if (rag.fallbackAn(model)) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GESPRAECH_TIMEOUT_MS);
  // Browser hat abgebrochen (z. B. Unterbrechen im freihändigen Gespräch): Claude-Strom sofort beenden.
  const beiAbbruch = () => ctrl.abort();
  if (abbruchSignal) { if (abbruchSignal.aborted) ctrl.abort(); else abbruchSignal.addEventListener('abort', beiAbbruch, { once: true }); }
  const start = Date.now();
  let text = '', stopGrund = null, satzEnde = -1, ersteTextMs = null, cache = null, gesendetBis = 0;
  try {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw kiFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die KI hat zu lange gebraucht.' : 'Keine Verbindung zum KI-Dienst.');
    }
    if (!r.ok) {
      const daten = await r.json().catch(() => null);
      // Nur Status und Fehlerart loggen – nie Schlüssel, Prompt, Nachricht oder Antwort.
      console.log(`Gespräch: KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
      if (r.status === 404) throw kiFehler(502, 'Das Gesprächsmodell ist unbekannt. Bitte ANTHROPIC_MODEL_GESPRAECH in .env prüfen.');
      throw kiFehler(502, meldungZuStatus(r.status));
    }
    try {
      for await (const ev of sseEreignisse(r.body)) {
        if (ev.type === 'message_start') cache = ev.message?.usage || null;
        else if (ev.type === 'content_block_start' && ev.content_block?.type === 'fallback') {
          // Ersatzmodell übernimmt: bisherigen Text verwerfen (kommt neu vom Ersatzmodell).
          if (satzEnde < 0 && gesendetBis === 0) text = '';
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (ersteTextMs === null) ersteTextMs = Date.now() - start;
          text += ev.delta.text;
          if (beiErstemSatz && satzEnde < 0) {
            const e = ersterSatzEnde(text);
            if (e > 0) { satzEnde = e; beiErstemSatz(text.slice(0, e)); }
          }
          if (jederSatz) {
            let e;
            while ((e = ersterSatzEnde(text.slice(gesendetBis))) > 0) { jederSatz(text.slice(gesendetBis, gesendetBis + e)); gesendetBis += e; }
          }
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stopGrund = ev.delta.stop_reason;
        else if (ev.type === 'error') {
          console.log(`Gespräch: Fehler im KI-Strom (${ev.error?.type || 'unbekannt'})`);
          throw kiFehler(502, ev.error?.type === 'overloaded_error' ? meldungZuStatus(529) : 'Die KI-Antwort wurde unterbrochen. Bitte erneut versuchen.');
        }
      }
    } catch (e) {
      if (e.meldung) throw e;
      throw kiFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die KI hat zu lange gebraucht.' : 'Die KI-Antwort wurde unterbrochen.');
    }
  } finally {
    clearTimeout(timer);
    if (abbruchSignal) abbruchSignal.removeEventListener('abort', beiAbbruch);
  }
  if (abbruchSignal?.aborted) throw Object.assign(kiFehler(499, 'Abgebrochen.'), { abgebrochen: true });
  if (stopGrund === 'refusal' && !text.trim()) throw kiFehler(502, 'Die KI hat diese Anfrage abgelehnt.');
  if (!text.trim()) throw kiFehler(502, 'Die KI hat keine Antwort geliefert.');
  // Abgeschnitten (max_tokens): den halben Schlusssatz weder sprechen noch anzeigen.
  if (stopGrund === 'max_tokens') {
    let ende = 0, e;
    while ((e = ersterSatzEnde(text.slice(ende))) > 0) ende += e;
    if (ende > 0 && !/[.!?…]["“”»)]?\s*$/.test(text)) text = text.slice(0, ende);
  }
  if (jederSatz && text.slice(gesendetBis).trim()) jederSatz(text.slice(gesendetBis));
  return {
    text, satzEnde, stopGrund, ersteTextMs, gesamtMs: Date.now() - start,
    cacheGelesen: cache?.cache_read_input_tokens || 0, cacheGeschrieben: cache?.cache_creation_input_tokens || 0,
  };
}

// ---------- Hybrid-Gespräch: Wer antwortet? ----------
// „nativ“  = der D-ID-Agent selbst (eigene KI + Anweisung aus D-ID Studio, Browser schickt „lk.chat“) – am schnellsten.
// „claude“ = Claude mit Wissensspeicher/Unterlagen und Quellen (bestehender Weg /api/avatar/gespraech).
// Entscheidung in zwei Stufen (vom Team prüfbar):
//   1. Vorfilter: Schlüsselwörter zu Unterlagen in allen App-Sprachen → sofort „claude“ (0 ms, ohne KI).
//   2. Sonst Claude Haiku (ohne Nachdenken, kurze JSON-Antwort) mit kurzem Verlauf + Titeln der Unterlagen.
//      Hartes Zeitlimit WEG_TIMEOUT_MS (Standard 1500 ms); bei Zeitüberschreitung oder Fehler → Claude, wenn Unterlagen da sind, sonst „nativ“.
// Modell per .env änderbar (WEG_MODELL). Gemessen am 27.11.2026 (Ein-Buchstaben-Antwort): claude-haiku-5-5 550–870 ms,
// claude-haiku-4-5 470–510 ms; mit JSON-Schema (structured output) 970–2200 ms → deshalb nur ein Kennbuchstabe.
const WEG_MODELL_STANDARD = 'claude-haiku-5-5';
const wegModell = () => { const m = String(process.env.WEG_MODELL || '').trim(); return /^claude-[a-z0-9-]+$/.test(m) ? m : WEG_MODELL_STANDARD; };
const WEG_TIMEOUT_MS = Math.min(3000, Math.max(300, Number(process.env.WEG_TIMEOUT_MS) || 1500));
const WEG_STICHWORTE = {
  uebersetzung: ['übersetz', 'uebersetz', 'translat', 'tradui', 'traduction', 'çevir', 'tercüme', 'ترجم', 'zusammenfass', 'summar', 'résum', 'özet', 'ملخص', 'لخص'],
  unterlagen: [
    'brief', 'befund', 'dokument', 'unterlage', 'medikament', 'tablette', 'labor', 'blutwert', 'diagnose', 'entlass', 'was steht', 'datum', 'dosis', 'dosierung', 'arztbericht', 'bericht', 'röntgen', 'mrt', 'ekg', 'krankenhaus', 'klinik', 'operation', 'operiert', 'behandlung', 'untersuchung', 'krankengeschichte', 'vorgeschichte',
    'letter', 'report', 'document', 'medication', 'medicine', 'pills', 'lab result', 'lab value', 'blood test', 'diagnos', 'discharge', 'what does it say', 'dose', 'dosage', 'my records', 'finding', 'hospital', 'surgery', 'treatment', 'medical history',
    'lettre', 'compte rendu', 'médicament', 'medicament', 'traitement', 'analyse', 'diagnostic', 'ordonnance', 'posologie', 'résultat', 'hôpital', 'hopital', 'opération', 'antécédent',
    'mektup', 'rapor', 'belge', 'ilaç', 'ilac', 'tahlil', 'laboratuvar', 'teşhis', 'tanı', 'doz', 'reçete', 'sonuç', 'hastane', 'ameliyat', 'tedavi',
    'رسالة', 'تقرير', 'مستند', 'وثيقة', 'دواء', 'أدوية', 'ادوية', 'تحليل', 'مختبر', 'تشخيص', 'جرعة', 'نتيجة', 'مستشفى', 'عملية', 'علاج',
    // Fragen über die eigene Person/Gesundheit (Nutzerwunsch 27.11.: Kontextfragen nie an den Avatar allein)
    'meine ', 'meinen ', 'meinem ', 'meiner ', 'meines ', 'mein arzt', 'habe ich', 'hatte ich', 'nehme ich', 'bin ich', 'war ich', 'bei mir', 'über mich', 'ueber mich',
    'arzt', 'ärzt', 'aerzt', 'termin', 'schmerz', 'symptom', 'allergi', 'blutdruck', 'zucker', 'herz', 'lunge', 'niere', 'leber', 'krebs', 'tumor', 'krank', 'gesundheit', 'therapie', 'impf',
    'my ', 'did i', 'do i have', 'am i', 'doctor', 'pain', 'symptom', 'allerg', 'blood pressure', 'heart', 'health',
    'mon ', 'ma ', 'mes ', 'médecin', 'medecin', 'douleur', 'santé', 'sante', 'cœur', 'coeur',
    'benim', 'doktor', 'ağrı', 'agri', 'sağlık', 'saglik', 'kalp',
    'طبيب', 'ألم', 'الم', 'صحة', 'قلب',
  ],
};
// Kennbuchstaben der Weiche → Weg und Grund.
const WEG_CODES = { U: ['claude', 'unterlagen'], E: ['claude', 'erklaerung'], T: ['claude', 'uebersetzung'], G: ['claude', 'gefuehl'], S: ['nativ', 'smalltalk'], N: ['nativ', 'sonstiges'] };
// Rein technische Weichen-Anweisung (welcher Dienst antwortet) – keine medizinischen Inhalte.
const WEG_ANWEISUNG = `Du bist die Weiche einer Gesundheits-App. Du beantwortest nichts selbst, sondern entscheidest nur, wer die letzte Nachricht der Patientin bzw. des Patienten beantwortet. Antworte mit genau einem Buchstaben:
U = Frage zu den eigenen Unterlagen (Arztbriefe, Befunde, Medikamente, Laborwerte, Diagnosen, Untersuchungen, Krankenhausaufenthalte, Termine, bisheriger Verlauf), Rückfrage zu einer Antwort daraus oder Frage zu etwas, das die Person früher erzählt hat (Personen, Beschwerden, Vorlieben)
E = verlangt eine ausführlichere medizinische Erklärung
T = Übersetzung oder Zusammenfassung eines Dokuments
G = Gefühle, Sorgen, Ängste, Traurigkeit, Einsamkeit oder seelische Belastung
S = Begrüßung, Smalltalk, kurzes Befinden ohne Belastung, Fragen zum Avatar selbst, Dank, Verabschiedung
N = alles andere
Nur bei KLAREN Anzeichen (nicht bei bloßem Verdacht, Sorgen oder Fragen zu früheren Erkrankungen) hängst du direkt an den Buchstaben ein Zeichen an: ! = Suizidalität, schwere Depression oder seelisches Trauma; + = akute schwere körperliche Erkrankung oder Verletzung (z. B. G! oder U+).`;

// App-Wissen (prompt/app-wissen.md): organisatorisches Handbuch, bei jeder Anfrage frisch gelesen (ohne HTML-Kommentare).
const APP_WISSEN_FILE = path.join(__dirname, 'prompt', 'app-wissen.md');
function appWissen() {
  try { return fs.readFileSync(APP_WISSEN_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim(); } catch { return ''; }
}
// Fragen zur Bedienung der App (alle App-Sprachen). „Rein“ = ohne medizinischen Inhalt → ohne Unterlagen-Suche (schneller)
// und ohne Lernen fürs Gedächtnis.
const APP_FRAGE_RE = new RegExp([
  // „Erklär mir, was du machst“ & Co. (Nutzerwunsch 28.11.2026) → App-Erklärung
  'was machst du', 'erklär(e)? mir( (mal|bitte|doch|kurz))*,? was du (machst|kannst|tust)', 'was du (so )?(machst|kannst)', 'wer bist du', 'was kann ich hier', 'was kann man hier', 'was bist du',
  'who are you', 'what do you do', 'what can i do here', 'how do you work', 'explain what you do', 'what are you',
  'qui es-tu', 'qui es tu', 'que fais-tu', 'tu fais quoi', 'qu.est-ce que (je peux|tu peux|tu sais) faire', 'comment tu (marches|fonctionnes)', 'explique-moi ce que tu fais',
  'sen kimsin', 'ne yapıyorsun', 'burada ne yapabilirim', 'nasıl çalışıyorsun', 'ne işe yarıyorsun',
  'من أنت', 'ماذا تفعل', 'ماذا يمكنني أن أفعل هنا', 'كيف تعمل', 'ما الذي تستطيع',
  'wie lade ich', 'hochlad', 'wo finde ich', 'wo ist der', 'wo ist die', 'was kannst du', 'was kann die app', 'wie funktioniert (die app|das hier|diese app|das mit)', 'wie funktionierst du',
  'wie stelle ich', 'stelle ich .{0,30} um', 'umstellen', 'wie lösche ich', 'wo lösche ich', 'wie kann ich .{0,30}(löschen|ändern|umbenennen)', 'einstellung', 'vergessen', 'datenschutz', 'wie scanne', 'scannen', 'zeitstrahl', 'quellen', 'knopf', 'mikrofon', 'freihändig',
  'stimme (ändern|wechseln)', 'sprache (ändern|wechseln|umstellen)', 'avatar (ändern|wechseln)', 'abmelden', 'wie benutze', 'wie bediene', '\\bapp\\b', 'meine unterlagen (finde|öffne)',
  'how (do|can) i (upload|scan|change|use|find|delete|remove|rename)', 'how to (upload|scan|change|delete)', 'where (do i find|is the)', 'what can you do', 'how does (the|this) app work', 'settings', 'privacy', 'forget', 'timeline', 'log out',
  'comment (télécharger|importer|scanner|changer|utiliser)', 'où (trouver|est)', 'que (peux|sais)-tu faire', 'comment ça marche', 'paramètres', 'réglages', 'confidentialité', 'oublier', 'chronologie', 'application',
  'nasıl yükle', 'nerede bul', 'ne yapabilirsin', 'nasıl çalışır', 'ayarlar', 'gizlilik', 'unut', 'zaman çizelgesi', 'dil(i)? değiştir', 'uygulama',
  'كيف أرفع', 'كيف أحمل', 'أين أجد', 'ماذا تستطيع', 'كيف يعمل', 'الإعدادات', 'إعدادات', 'الخصوصية', 'انس', 'الجدول الزمني', 'التطبيق',
].join('|'), 'i');
const MEDIZIN_RE = /medikament|tablette|diagnos|befund|labor|blutwert|schmerz|symptom|krank|herz|blutdruck|allergi|therapie|operation|dosis|was steht|brief vom|medication|pill|diagnos|pain|heart|médicament|douleur|cœur|ilaç|ağrı|kalp|دواء|ألم|قلب/i;
// Knöpfe, die eine App-Erklärung nennt → Schlüssel für das Leuchten (Element-IDs bzw. Kurz-Schlüssel des Design-Agenten,
// siehe werkzeuge/SCHNITTSTELLEN_RUNDE2.md). Knopfnamen stehen laut App-Wissen auch in anderen Sprachen auf Deutsch.
const KNOEPFE = [
  [/„Schreiben“|"Schreiben"|«\s?Schreiben\s?»|\bTippfeld\b|\bStift\b|mir schreiben|\btype\b|write to me|m'écrire|m’écrire|yazabilirsin|تكتب/i, 'tastatur'],
  [/„Übersicht“|"Übersicht"|«\s?Übersicht\s?»|Startseite|Mit mitano\. reden/i, 'anfang'],
  [/„Termine“|"Termine"|Neuer Termin|„Medikamentenplan“|"Medikamentenplan"/, 'dash-termin-neu'], [/Mikrofon|microphone|\bmicro\b|mikrofon|ميكروفون/i, 'mikro'],
  [/Meine Unterlagen|Knopf mit der Zahl|„Unterlagen“/i, 'kontext-knopf'], [/„Stopp“|"Stopp"|\bStopp\b/, 'stopp'], [/„Quellen“|"Quellen"/, 'quellen-knopf'],
  [/Zahnrad|Einstellungen|gear icon|roue dentée|dişli|الترس/i, 'einstellungen-knopf'], [/„Zeitstrahl“|"Zeitstrahl"|«\s?Zeitstrahl\s?»|\bZeitstrahl\b|\btimeline\b|chronologi|zaman çizelgesi|الخط الزمني/i, 'tab-zeitstrahl'],
  [/„Dokumente“|"Dokumente"/, 'tab-dokumente'], [/„Scannen“|"Scannen"|Dokument scannen/, 'scannen'], [/Datei hochladen/, 'datei-knopf'],
  [/„Original“|"Original"/, 'tab-original'], [/„Einfach“|"Einfach"/, 'tab-einfach'], [/In einfache Sprache übersetzen/, 'uebersetzen'],
  [/Vorlesen lassen/, 'vorlesen'], [/„Umbenennen“|"Umbenennen"/, 'dok-umbenennen'], [/„Löschen“|"Löschen"|Wirklich löschen/, 'dok-loeschen'],
  [/Alles vergessen/, 'gd-alles'], [/Was mitano\.? über dich weiß/i, 'gedaechtnis'], [/Gesprächsprotokoll|Protokoll leeren/, 'protokoll-knopf'],
  [/Neu beginnen/, 'neu-gespraech'], [/„Abmelden“|"Abmelden"|\bAbmelden\b/, 'logout'], [/„Stimme“|"Stimme"|Probehören/, 'stimme'],
  [/„Sprache“|"Sprache"|Jetzt in der neuen Sprache verbinden/, 'sprache'], [/„Avatar“|"Avatar"/, 'avatar'], [/„Datenschutz“|"Datenschutz"/, 'datenschutz'],
];
function knoepfeIn(text) {
  const t = String(text || '');
  return KNOEPFE.filter(([re]) => re.test(t)).map(([, k]) => k);
}
function istAppFrage(nachricht) {
  const t = String(nachricht || '');
  return APP_FRAGE_RE.test(t) && !MEDIZIN_RE.test(t);
}
function wegVorfilter(nachricht) {
  const t = nachricht.toLowerCase();
  for (const [grund, worte] of Object.entries(WEG_STICHWORTE)) if (worte.some((w) => t.includes(w))) return grund;
  return null;
}
function ueberbrueckung(sprache, grund) {
  const s = UEBERBRUECKUNG[sprache] || UEBERBRUECKUNG[SPRACHE_STANDARD];
  const liste = grund === 'unterlagen' || grund === 'uebersetzung' ? s.unterlagen : grund === 'gedaechtnis' ? s.erinnern : grund === 'app' ? s.app
    : grund === 'gefuehl' ? s.gefuehl : grund === 'krise' ? s.krise : s.nachdenken;
  return liste[crypto.randomInt(liste.length)];
}
// Liefert { weg, grund, quelle: 'vorfilter'|'ki'|'zeitlimit'|'fehler'|'ohne_claude', ms }. Loggt nie Inhalte.
async function waehleWeg({ nachricht, verlauf, titel, stand, patientId = null, gedaechtnisDa = false }) {
  const t0 = Date.now();
  const fertig = (weg, grund, quelle) => ({ weg, grund, quelle, ms: Date.now() - t0 });
  // Unsicher (Zeitlimit/Fehler)? Wenn Unterlagen vorhanden sind, lieber Claude mit Unterlagen als den Avatar allein.
  const rueckfall = (quelle) => (titel && titel.length ? fertig('claude', 'unterlagen', quelle) : gedaechtnisDa ? fertig('claude', 'gedaechtnis', quelle) : fertig('nativ', 'sonstiges', quelle));
  if (!stand.bereit) return fertig('nativ', 'sonstiges', 'ohne_claude');
  // Krise zuerst (Stichworte, 5 Sprachen), dann Gefühle → immer Claude.
  const sw = kriseStichwort(nachricht);
  if (sw) return { ...fertig('claude', 'krise', 'vorfilter'), krise: sw };
  if (GEFUEHL_RE.test(nachricht)) return fertig('claude', 'gefuehl', 'vorfilter');
  // Reine Frage zur Bedienung der App → Claude mit App-Wissen (ohne Unterlagen-Suche).
  if (istAppFrage(nachricht)) return fertig('claude', 'app', 'vorfilter');
  // Frage nach früher Erzähltem („vorhin“, „wie heißt mein Hausarzt“, bekannte Namen) → Claude mit Gedächtnis.
  if (patientId && gd.istGedaechtnisFrage(nachricht, patientId)) return fertig('claude', 'gedaechtnis', 'vorfilter');
  const vf = wegVorfilter(nachricht);
  if (vf) return fertig('claude', vf, 'vorfilter');
  const key = process.env.ANTHROPIC_API_KEY || '';
  const kurz = (t, n) => (t.length > n ? t.slice(0, n) + ' …' : t);
  const inhalt = `<verlauf>\n${verlauf.slice(-4).map((v) => `${v.rolle === 'avatar' ? 'Avatar' : 'Patient'}: ${kurz(v.text, 300)}`).join('\n') || '(leer)'}\n</verlauf>\n` +
    `<unterlagen>\n${titel.slice(0, 30).map((x) => '- ' + kurz(x, 80)).join('\n') || '(keine)'}\n</unterlagen>\n<nachricht>\n${kurz(nachricht, 1000)}\n</nachricht>`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEG_TIMEOUT_MS);
  try {
    const model = wegModell();
    const body = { model, max_tokens: 3, system: WEG_ANWEISUNG, messages: [{ role: 'user', content: inhalt }] };
    if (!/^claude-(haiku|sonnet)-4-5/.test(model)) body.thinking = { type: 'disabled' };   // neuere Modelle: ohne Nachdenken
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify(body),
    });
    const daten = await r.json().catch(() => null);
    if (!r.ok) { console.log(`Weg: KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`); return rueckfall('fehler'); }
    if (daten?.stop_reason === 'refusal') return fertig('claude', 'sonstiges', 'ki');   // heikle Frage → lieber Claude mit Unterlagen
    const antwortText = ((daten?.content || []).find((b) => b.type === 'text')?.text || '').trim();
    const code = antwortText.charAt(0).toUpperCase();
    if (antwortText.includes('!')) return { ...fertig('claude', 'krise', 'ki'), krise: 'seelisch' };
    // '+' (körperlich) der KI-Weiche wird nicht mehr als Krise gewertet (Demo-Fix 28.11.) – nur Stichworte lösen das aus.
    if (!WEG_CODES[code]) return rueckfall('fehler');
    return fertig(WEG_CODES[code][0], WEG_CODES[code][1], 'ki');
  } catch (e) {
    return rueckfall(e.name === 'AbortError' ? 'zeitlimit' : 'fehler');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- D-ID: Aufrufe ----------
function didMeldung(status, art) {
  if (status === 401) return 'Der D-ID-Schlüssel wurde abgelehnt. Bitte DID_API_KEY in .env prüfen.';
  if (status === 402 || art === 'InsufficientCreditsError') return 'Das D-ID-Guthaben ist aufgebraucht.';
  if (status === 403 && art === 'ConcurrencyLimitError') return 'Zu viele Avatar-Verbindungen gleichzeitig. Bitte andere Avatar-Fenster schließen und kurz warten.';
  if (status === 403) return 'D-ID erlaubt diese Funktion für das Konto nicht.';
  if (status === 404) return 'Die Avatar-Verbindung ist abgelaufen. Bitte neu verbinden.';
  if (status === 429) return 'D-ID ist gerade ausgelastet. Bitte kurz warten.';
  if (status >= 500) return 'D-ID ist gerade nicht erreichbar. Bitte später erneut versuchen.';
  return 'D-ID hat die Anfrage nicht angenommen.';
}

async function did(methode, pfad, body) {
  const key = process.env.DID_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw kiFehler(503, 'Der D-ID-Schlüssel fehlt noch. Bitte DID_API_KEY in .env eintragen und den Server neu starten.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DID_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch(DID_URL + pfad, {
      method: methode,
      // Laut D-ID-Doku wird der Schlüssel unverändert als "Basic <key>" gesendet.
      headers: { Authorization: 'Basic ' + key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    daten = await r.json().catch(() => ({}));
  } catch (e) {
    throw kiFehler(e.name === 'AbortError' ? 504 : 502, 'Keine Verbindung zu D-ID.');
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // Nur Status und Fehlerart loggen – nie Schlüssel oder Text.
    console.log(`D-ID-Anfrage fehlgeschlagen (${methode} Status ${r.status}${daten?.kind ? ', ' + daten.kind : ''})`);
    throw Object.assign(kiFehler(502, didMeldung(r.status, daten?.kind)), { didStatus: r.status, didArt: daten?.kind || null });
  }
  return daten;
}

// Pro Avatar einmalig einen Agent ohne KI anlegen und merken (lokal/did-agents.json, in .gitignore).
function ladeAgentIds() {
  let ids = {};
  try { ids = JSON.parse(fs.readFileSync(DID_AGENTS_FILE, 'utf8')) || {}; } catch {}
  // Den früher angelegten Einzel-Avatar (Emma) weiterverwenden.
  if (!ids.emma) {
    try { const alt = JSON.parse(fs.readFileSync(DID_AGENT_FILE, 'utf8')).id; if (alt) ids.emma = alt; } catch {}
  }
  return ids;
}
function speichereAgentId(avatarId, agentId) {
  const ids = ladeAgentIds();
  ids[avatarId] = agentId;
  schreibeJsonAtomar(DID_AGENTS_FILE, ids, 2);
}

const agentWirdAngelegt = new Map();   // avatarId -> Promise (verhindert doppelte Anlage)
async function didAgent(avatar) {
  if (avatar.id === AVATAR_STANDARD && process.env.DID_AGENT_ID) return process.env.DID_AGENT_ID;
  const vorhanden = ladeAgentIds()[avatar.id];
  if (vorhanden) return vorhanden;
  if (!agentWirdAngelegt.has(avatar.id)) {
    agentWirdAngelegt.set(avatar.id, (async () => {
      const a = await did('POST', '/agents', {
        preview_name: `AKKI Avatar-Uebersetzer – ${avatar.name} (ohne KI)`,
        presenter: {
          type: 'talk', source_url: avatar.bild, thumbnail: avatar.bild,
          voice: { type: 'microsoft', voice_id: avatar.stimme },
        },
      });
      for (let i = 0; i < 30 && a.status !== 'done'; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const st = await did('GET', `/agents/${encodeURIComponent(a.id)}`);
        if (st.status === 'done') break;
        if (st.status === 'error') throw kiFehler(502, 'D-ID konnte den Avatar nicht anlegen.');
      }
      speichereAgentId(avatar.id, a.id);
      console.log(`D-ID-Avatar „${avatar.name}“ wurde einmalig angelegt.`);
      return a.id;
    })().finally(() => { agentWirdAngelegt.delete(avatar.id); }));
  }
  return agentWirdAngelegt.get(avatar.id);
}

// Leerlauf-Video des Agents (falls D-ID eins erzeugt hat). Nur merken, wenn vorhanden.
const leerlaufCache = new Map();   // agentId -> URL
async function didLeerlauf(agentId) {
  if (leerlaufCache.has(agentId)) return leerlaufCache.get(agentId);
  try {
    const a = await did('GET', `/agents/${encodeURIComponent(agentId)}`);
    const url = a && a.presenter && a.presenter.idle_video;
    if (typeof url === 'string' && url.startsWith('https://agents-results.d-id.com/')) {
      leerlaufCache.set(agentId, url);
      return url;
    }
  } catch {}
  return null;
}

// ---------- D-ID-Studio-Agent: Daten lesen (kurz gecacht), Anweisung ändern ----------
const studioCache = new Map();   // agentId -> { zeit, daten }
async function studioAgent(agentId, frisch = false) {
  const c = studioCache.get(agentId);
  if (!frisch && c && Date.now() - c.zeit < STUDIO_CACHE_MS) return c.daten;
  const daten = await did('GET', `/agents/${encodeURIComponent(agentId)}`);
  studioCache.set(agentId, { zeit: Date.now(), daten });
  return daten;
}
const urlMit = (u, basis) => (typeof u === 'string' && [].concat(basis).some((b) => u.startsWith(b)) ? u : null);
function studioDarstellung(agent, sprache, agentId) {
  const p = agent.presenter || {};
  // Anzeigename: Präfix „AKKI Kumpel “ / „AKKI “ weglassen. Technische Namen (z. B. „Gesundheits-Kumpel (DE)“)
  // nicht anzeigen, sondern den Namen des D-ID-Standard-Presenters aus der Bildadresse nehmen (z. B. „Emma“).
  const roherName = (typeof agent.preview_name === 'string' ? agent.preview_name.trim() : '').replace(/^AKKI (Kumpel )?/, '');
  const ausBild = /\/DefaultPresenters\/([A-Za-z]{2,20})_/.exec(String(p.source_url || ''))?.[1];
  const name = /^\p{L}[\p{L} .'-]{1,30}$/u.test(roherName) && !/kumpel/i.test(roherName) ? roherName : ausBild || 'Dein Kumpel';
  return {
    id: 'studio-' + agentId, name, typ: 'studio', sprache, technik: didTechnik(agent),
    sprachen: studioAvatare().find((a) => a.id === agentId)?.sprachen || [sprache],
    // Bild = Standbild aus dem Live-Strom. Studio-Foto (thumbnail/source_url) und Leerlauf-Video werden bewusst
    // nicht verwendet: sie zeigen ein anders aussehendes Modell.
    bild: standbildAdresse(agentId),
    beschreibung: 'Dein Begleiter mitano. – erklärt dir deine Unterlagen und hört dir zu.',
  };
}
// Standbild des Avatars = Bild aus dem LIVE-Strom (D-ID V2), denn Studio-Foto und Leerlauf-Video zeigen ein sichtbar
// anderes Modell. Reihenfolge: zuletzt vom Browser aufgenommenes Live-Bild (lokal/standbild/<agentId>-live.jpg)
// → mitgeliefertes Live-Bild der Avatar-Gruppe (public/avatar/<gruppe>-live.jpg) → keins.
// (lokal/standbild/ ist optional, z. B. für ein später ausgetauschtes Live-Bild ohne neuen Commit.)
const STANDBILD_DIR = path.join(__dirname, 'lokal', 'standbild');
const standbildBekannt = (agentId) => gueltigeAgentId(agentId) && studioAvatare().some((a) => a.id === agentId);
const standbildLiveDatei = (agentId) => path.join(STANDBILD_DIR, agentId + '-live.jpg');
function standbildMitgeliefert(agentId) {
  const g = studioAvatare().find((a) => a.id === agentId)?.gruppe;
  const f = g && path.join(PUBLIC_DIR, 'avatar', g + '-live.jpg');
  return f && fs.existsSync(f) ? f : null;
}
function standbildDatei(agentId) {
  if (!standbildBekannt(agentId)) return null;
  if (fs.existsSync(standbildLiveDatei(agentId))) return standbildLiveDatei(agentId);
  return standbildMitgeliefert(agentId);
}
function standbildAdresse(agentId) {
  const f = standbildDatei(agentId);
  if (!f) return null;
  let v = 0; try { v = Math.round(fs.statSync(f).mtimeMs); } catch {}
  return '/api/avatar/standbild/' + encodeURIComponent(agentId) + '?live=' + v;
}
// Offene D-ID-Verbindung beenden. Liefert ein Promise (true = gelöscht), das nie ablehnt.
function loescheDidSitzung(av) {
  if (!av) return Promise.resolve(false);
  const p = av.technik === 'v2'
    // V2: Sitzung samt Mitschrift/Aufnahme bei D-ID löschen (der Browser verlässt den LiveKit-Raum selbst).
    ? did('DELETE', `/v2/agents/sessions/${encodeURIComponent(av.sessionId)}`)
    : did('DELETE', `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}`, { session_id: av.sessionId });
  return p.then(() => true, () => false);
}
function stoppeAvatar(s) {
  const av = s && s.avatar;
  if (!av) return Promise.resolve(false);
  s.avatar = null;
  return loescheDidSitzung(av);
}

// Sprache aus der Anfrage lesen: fehlt sie, gilt Deutsch; unbekannte Werte -> null (Fehler 400).
function leseSprache(wert) {
  if (wert === undefined || wert === null || wert === '') return SPRACHE_STANDARD;
  return typeof wert === 'string' && Object.hasOwn(SPRACHEN, wert) ? wert : null;
}
function xmlSicher(text) {
  return text.replace(/[<>&"']/g, (z) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[z]);
}

// Die Stimme wird bei jedem Sprechauftrag mitgeschickt (überschreibt die im D-ID-Agent hinterlegte).
// Per SSML <lang> wird die Sprache fest vorgegeben, damit die mehrsprachige Stimme richtig ausspricht.
async function avatarSprichText(roh, text, sprache = SPRACHE_STANDARD) {
  const av = roh.avatar;
  if (av.typ === 'studio') {
    // Studio-Agent: ohne „provider“ nimmt D-ID die im Agent hinterlegte Stimme (z. B. ElevenLabs).
    const r = await did('POST', `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}`, {
      session_id: av.sessionId, script: { type: 'text', input: text },
    });
    return r.duration || null;
  }
  const locale = (SPRACHEN[sprache] || SPRACHEN[SPRACHE_STANDARD]).locale;
  const r = await did('POST', `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}`, {
    session_id: av.sessionId,
    script: {
      type: 'text', ssml: true,
      input: `<lang xml:lang="${locale}">${xmlSicher(text)}</lang>`,
      provider: { type: 'microsoft', voice_id: av.stimme || DID_STIMME },
    },
  });
  return r.duration || null;
}

// Gespräch für V2-Avatare: Antwort von Claude (gleicher Prompt, Unterlagen, Verlauf wie /api/avatar/gespraech),
// aber Satz für Satz als Server-Sent-Events. Der Browser schickt jeden Satz sofort an den Avatar.
// Log nur mit Zahlen – nie Nachricht oder Antwort.
// Freihändiges Gespräch: Markierung, wenn der Patient eine Antwort unterbrochen hat (technischer Kontext, kein Inhalt).
const UNTERBROCHEN_MARKE = ' [vom Patienten unterbrochen – nicht vollständig gehört]';
// „Ja, erzähl mehr“ nach der Satzbremse: gemerkten Rest sprechen (kein neuer Claude-Aufruf).
function restStrom(res, roh, offen, { nachricht, t0 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  const senden = (ereignis, daten) => res.write(`event: ${ereignis}\ndata: ${JSON.stringify(daten)}\n\n`);
  for (const t of offen.saetze) senden('satz', { text: t });
  const antwort = offen.saetze.join(' ');
  const zeit = new Date().toISOString();
  roh.protokoll.push({ rolle: 'nutzer', text: nachricht, zeit, weg: 'claude' }, { rolle: 'avatar', text: antwort, zeit, weg: 'claude' });
  if (roh.protokoll.length > MAX_PROTOKOLL) roh.protokoll.splice(0, roh.protokoll.length - MAX_PROTOKOLL);
  console.log(`Gespräch (V2): gemerkten Rest gesprochen (${offen.saetze.length} Sätze, ${Date.now() - t0} ms).`);
  senden('fertig', {
    antwort, gesprochen: true, sprechAuftraege: offen.saetze.length, sprache: offen.sprache, modus: 'ki', rest: true,
    dauerMs: Date.now() - t0, dauerGesamtMs: Date.now() - t0, patientId: offen.quellen.length ? offen.patientId : null,
    quellen: offen.quellen, antwortMitMarkern: offen.antwortMitMarkern, gedaechtnisQuellen: offen.gedaechtnisQuellen, restOffen: false,
  });
  res.end();
}
// Vorab gestartete Suchbegriffe holen (nur für dieselbe Nachricht); wartet höchstens SUCHBEGRIFFE_WARTE_MS ab Weg-Entscheidung.
const SUCHBEGRIFFE_WARTE_MS = Math.min(4000, Math.max(0, Number(process.env.SUCHBEGRIFFE_WARTE_MS) || 1800));
async function vorabBegriffe(roh, nachricht) {
  const v = roh.suchVorlauf; roh.suchVorlauf = null;
  if (!v || v.nachricht !== nachricht) return null;
  const rest = Math.max(0, v.start + SUCHBEGRIFFE_WARTE_MS - Date.now());
  const r = await Promise.race([v.p, new Promise((ok) => setTimeout(() => ok(null), rest))]);
  return r && Array.isArray(r.begriffe) && r.begriffe.length ? r.begriffe : null;
}
// ---------- Spekulativer Start (Latenz, Runde 2) ----------
// Sobald die Weiche „claude“ nahelegt, startet die Claude-Antwort schon während der Weg-Anfrage. Die Sätze werden
// gepuffert; die folgende Gesprächsanfrage mit derselben Nachricht hängt sich an. Bei „nativ“, Gefühl/Krise/App oder
// abweichender Nachricht/Sprache wird abgebrochen. .env SPEKULATIV=an|aus (Standard an).
const spekulativAn = () => String(process.env.SPEKULATIV || 'an').trim().toLowerCase() !== 'aus';
const SPEKULATION_MAX_MS = 30 * 1000;
function verlaufSchluessel(verlauf) {
  const l = (verlauf || [])[Math.max(0, (verlauf || []).length - 1)];
  return `${(verlauf || []).length}|${l ? l.rolle + ':' + String(l.text).slice(0, 80) : ''}`;
}
// Erzeugt die Antwort (Wissensspeicher bzw. Claude ohne Unterlagen); Sätze gehen an job.hoerer oder in den Puffer.
function starteErzeugung(roh, { nachricht, verlauf, stand, dokumente, sprache, patientId, krise = null, appFrage = false, gedaechtnis }) {
  const job = { nachricht, sprache, verlaufSchluessel: verlaufSchluessel(verlauf), start: Date.now(), puffer: [], hoerer: null, abbruch: new AbortController(), gedaechtnis };
  const beiSatz = (t) => { if (job.abbruch.signal.aborted) throw Object.assign(kiFehler(499, 'Abgebrochen.'), { abgebrochen: true }); if (job.hoerer) job.hoerer(t); else job.puffer.push(t); };
  job.fertig = (async () => {
    if (!appFrage) { const dk = await dashboardKontext(patientId, nachricht); if (dk) gedaechtnis.text = [gedaechtnis.text, dk].filter(Boolean).join('\n\n'); }
    const begriffe = appFrage ? null : await vorabBegriffe(roh, nachricht);
    let wissen = null, ki = null;
    if (stand.bereit && patientId && !appFrage) {
      wissen = await ragAntwort({ patientId, nachricht, verlauf, stand, sprache, beiSatz, fokusDocs: roh.letzteQuellenDocs || [], gedaechtnis, signal: job.abbruch.signal, begriffe });
    }
    if (!wissen && stand.bereit) {
      ki = await kiAntwortStream(baueSystem(stand.systemprompt, dokumente, sprache, gedaechtnis.text), baueNachrichten(verlauf, nachricht), stand.modell, null, beiSatz, job.abbruch.signal);
    }
    return { wissen, ki };
  })();
  job.fertig.catch(() => {});   // Fehler wertet der Abnehmer aus
  return job;
}
function verwirfSpekulation(roh) {
  const j = roh.spekulation; roh.spekulation = null;
  if (j) { j.abbruch.abort(); if (j.timer) clearTimeout(j.timer); }
}
async function gespraechStrom(res, roh, { nachricht, verlauf, stand, dokumente, sprache, t0, patientId }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  let offen = true;
  // Browser bricht ab (Unterbrechen, Seite zu, Netz weg): Claude-Strom beenden statt ihn ins Leere laufen zu lassen.
  const abbruch = new AbortController();
  const ABGEBROCHEN = Object.assign(kiFehler(499, 'Abgebrochen.'), { abgebrochen: true });
  res.on('close', () => { offen = false; if (!res.writableEnded) abbruch.abort(); });
  const senden = (ereignis, daten) => { if (offen) res.write(`event: ${ereignis}\ndata: ${JSON.stringify(daten)}\n\n`); };
  let saetze = 0, ersterSatzMs = null, ki = null, antwort, wissen = null, spekulativGenutzt = null;
  const gehoert = [];   // Sätze, die vor einem Abbruch beim Browser angekommen sind
  const stromStart = Date.now(); roh.stromLaeuftSeit = stromStart;
  const zurueck = [];   // Satzbremse: Sätze nach dem SATZBREMSE-ten (erst am Ende entschieden)
  let gezaehlt = 0;
  let krise = false;
  // App-Erklärung: genannte Knöpfe sofort melden (Ereignis „knoepfe“ vor dem Satz), damit sie leuchten, während mitano. spricht.
  const knoepfeMelden = istAppFrage(nachricht) && !kriseStichwort(nachricht);
  const knoepfe = new Set();
  const sende = (t) => {
    if (knoepfeMelden) {
      const neu = knoepfeIn(t).filter((k) => !knoepfe.has(k));
      if (neu.length) { neu.forEach((k) => knoepfe.add(k)); senden('knoepfe', { knoepfe: neu }); }
    }
    if (ersterSatzMs === null) ersterSatzMs = Date.now() - t0;
    saetze++;
    gehoert.push(t);
    senden('satz', { text: t });
  };
  const satz = (roh) => {
    if (abbruch.signal.aborted) throw ABGEBROCHEN;
    const t = ohneMarkdown(roh).slice(0, MAX_SPRECHTEXT);
    if (!t) return;
    if (!SATZBREMSE || !stand.bereit || krise) return sende(t);   // Krise: Hilfe-Sätze nie abschneiden
    for (const einzel of zerlegeSaetze(t)) {
      if (gezaehlt >= SATZBREMSE) { zurueck.push(einzel); continue; }
      gezaehlt++;
      sende(einzel);
    }
  };
  roh.kriseLetzte = null;
  krise = stand.bereit ? await istKrise(roh, nachricht, GEFUEHL_RE.test(nachricht)) : null;
  if (krise) roh.offenerRest = null;
  const appFrage = !krise && istAppFrage(nachricht);
  // Spekulativ gestartete Antwort übernehmen, wenn sie genau zu dieser Anfrage passt (sonst verwerfen).
  let job = null;
  const sp = roh.spekulation;
  if (sp && !krise && !appFrage && sp.nachricht === nachricht && sp.sprache === sprache && sp.verlaufSchluessel === verlaufSchluessel(verlauf)
      && Date.now() - sp.start < SPEKULATION_MAX_MS && !sp.abbruch.signal.aborted) {
    roh.spekulation = null; if (sp.timer) clearTimeout(sp.timer);
    job = sp; spekulativGenutzt = Date.now() - sp.start;
  } else verwirfSpekulation(roh);
  const gedaechtnis = job ? job.gedaechtnis : appFrage ? { text: '', fakten: [] } : gedaechtnisFuer(patientId, nachricht);
  if (krise) gedaechtnis.text = [gedaechtnis.text, krisenHinweis(krise)].filter(Boolean).join('\n\n');
  try {
    if (stand.bereit) {
      if (!job) job = starteErzeugung(roh, { nachricht, verlauf, stand, dokumente, sprache, patientId, krise, appFrage, gedaechtnis });
      abbruch.signal.addEventListener('abort', () => job.abbruch.abort(), { once: true });
      if (abbruch.signal.aborted) job.abbruch.abort();
      // Gepufferte Sätze sofort senden, danach live weiterreichen.
      const gepuffert = job.puffer.splice(0);
      job.hoerer = satz;
      for (const t of gepuffert) satz(t);
      ({ wissen, ki } = await job.fertig);
      if (wissen) roh.letzteQuellenDocs = [...new Set(wissen.quellen.map((q) => q.docId))].slice(0, 3);
    }
    if (wissen) {
      antwort = ohneMarkdown(wissen.text);
    } else if (stand.bereit && ki) {
      antwort = ohneMarkdown(ki.text);
    } else {
      antwort = SPRACHEN[sprache].echo + nachricht;
      satz(antwort);
    }
  } catch (e) {
    if (roh.stromLaeuftSeit === stromStart) roh.stromLaeuftSeit = null;
    if (abbruch.signal.aborted || e.abgebrochen) {
      // Abgebrochen: Frage und der schon gehörte Teil der Antwort (als unterbrochen markiert) ins Gedächtnis.
      if (gehoert.length) {
        const zeit = new Date().toISOString();
        roh.protokoll.push({ rolle: 'nutzer', text: nachricht, zeit, weg: 'claude' }, { rolle: 'avatar', text: gehoert.join(' ') + UNTERBROCHEN_MARKE, zeit, weg: 'claude' });
        if (roh.protokoll.length > MAX_PROTOKOLL) roh.protokoll.splice(0, roh.protokoll.length - MAX_PROTOKOLL);
      }
      if (!krise) lerneImHintergrund(patientId, nachricht, gehoert.join(' '), sprache);   // was die Person sagte, zählt auch bei Abbruch (nicht bei Krise)
      console.log(`Gespräch (V2): vom Browser abgebrochen nach ${saetze} Satz/Sätzen, Strom beendet (${Date.now() - t0} ms).`);
      return res.end();
    }
    console.log(`Gespräch (V2): Fehler nach ${saetze} Satz/Sätzen.`);
    senden('fehler', { fehler: e.meldung || 'Die Antwort konnte nicht erzeugt werden.', saetze });
    return res.end();
  }
  const zeit = new Date().toISOString();
  if (roh.stromLaeuftSeit === stromStart) roh.stromLaeuftSeit = null;
  // Satzbremse: ein einzelner zurückgehaltener Satz wird noch gesprochen; ab zwei wird gemerkt und nachgefragt.
  let restOffen = false;
  const volleAntwort = antwort;
  if (zurueck.length === 1) sende(zurueck[0]);
  else if (zurueck.length > 1) {
    roh.offenerRest = { saetze: zurueck.slice(), seit: Date.now(), sprache, patientId,
      quellen: wissen ? quellenSicht(wissen.quellen) : [], antwortMitMarkern: wissen ? wissen.textMitMarkern : null,
      gedaechtnisQuellen: gedaechtnisQuellen(wissen ? wissen.gedaechtnisFakten : gedaechtnis.fakten, volleAntwort) };
    sende(MEHR_ANGEBOT[sprache] || MEHR_ANGEBOT.de);
    restOffen = true;
  }
  if (restOffen || zurueck.length === 1) antwort = gehoert.join(' ');   // Untertitel/Gedächtnis = Gesprochenes
  // Freihändiges Gespräch: Hat der Patient diese Antwort unterbrochen, steht das im Gedächtnis (Kontext für Claude).
  if (roh.unterbrochenUm && roh.unterbrochenUm >= stromStart) antwort += UNTERBROCHEN_MARKE;
  roh.protokoll.push({ rolle: 'nutzer', text: nachricht, zeit, weg: 'claude' }, { rolle: 'avatar', text: antwort, zeit: new Date().toISOString(), weg: 'claude' });
  if (roh.protokoll.length > MAX_PROTOKOLL) roh.protokoll.splice(0, roh.protokoll.length - MAX_PROTOKOLL);
  const kriseArt = krise || (KRISEN_ARTEN.includes(roh.kriseLetzte?.ergebnis) ? roh.kriseLetzte.ergebnis : null);
  if (stand.bereit && !kriseArt) lerneImHintergrund(patientId, nachricht, antwort, sprache);   // Krisen nie automatisch ins Gedächtnis
  const dauerMs = ersterSatzMs ?? (Date.now() - t0);
  console.log(`Gespräch (V2): ${wissen ? 'Wissensspeicher' : stand.bereit ? 'KI' : 'Echo'}, Patient ${patientId || '–'}, ${dokumente.length} Dok., erster Satz ${dauerMs} ms` +
    (wissen ? `, Suche ${wissen.zeiten.erweiterungMs + wissen.zeiten.sucheMs} ms (${wissen.suchbegriffe.length} Zusatzbegriffe), erster Text ${wissen.zeiten.ersteTextMs} ms, ${wissen.quellen.length} Quellen` : '') +
    (ki ? `, erster Text ${ki.ersteTextMs} ms, KI gesamt ${ki.gesamtMs} ms, Cache gelesen ${ki.cacheGelesen}/geschrieben ${ki.cacheGeschrieben} Tokens` : '') +
    `, ${saetze} Satz/Sätze` + (spekulativGenutzt !== null ? `, spekulativ (Vorsprung ${spekulativGenutzt} ms)` : ''));
  senden('fertig', {
    antwort, gesprochen: saetze > 0, sprechAuftraege: saetze, sprache,
    modus: stand.bereit ? 'ki' : 'echo',
    modell: stand.bereit ? stand.modell : null,
    dauerMs, dauerGesamtMs: Date.now() - t0,
    anbieter: stand.bereit ? GESPRAECH_ANBIETER : null,
    kontextDokumente: dokumente.length,
    hinweis: stand.grund,
    quelle: stand.quelle,
    patientId: wissen ? patientId : null,
    quellen: wissen ? quellenSicht(wissen.quellen) : [],
    antwortMitMarkern: wissen ? wissen.textMitMarkern : null,
    gedaechtnisQuellen: stand.bereit ? gedaechtnisQuellen(wissen ? wissen.gedaechtnisFakten : gedaechtnis.fakten, volleAntwort) : [],
    restOffen,
    ...(knoepfeMelden ? { zeigeKnoepfe: [...new Set([...knoepfe, ...knoepfeIn(volleAntwort)])] } : {}),
    ...(kriseArt ? { krise: kriseArt, hilfe: krisenHilfe(kriseArt, sprache) } : {}),
  });
  res.end();
}

async function avatarRoute(route, req, res, roh) {
  const basis = () => {
    const av = roh.avatar;
    if (!av) throw kiFehler(409, 'Der Avatar ist nicht verbunden. Bitte zuerst „Avatar verbinden“ drücken.');
    if (av.technik === 'v2') throw kiFehler(409, 'Dieser Avatar wird direkt vom Browser gesteuert.');
    return { av, pfad: `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}` };
  };

  const mStand = req.method === 'GET' && route.match(/^GET \/api\/avatar\/standbild\/([A-Za-z0-9_-]{3,64})$/);
  if (mStand) {
    const datei = standbildDatei(mStand[1]);
    if (!datei) return sendJson(res, 404, { fehler: 'Für diesen Avatar gibt es noch kein Standbild.' });
    const daten = fs.readFileSync(datei);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': daten.length });
    return res.end(daten);
  }
  if (route === 'POST /api/avatar/start') {
    const b = (await readJson(req, MAX_BODY_AVATAR)) || {};
    // Doppelte/überholte Starts: Nur der jüngste Start derselben Sitzung darf seine D-ID-Sitzung behalten. Ist der
    // Browser schon weg, die Anmeldung beendet oder der Server fährt herunter, wird die neue D-ID-Sitzung sofort
    // wieder gelöscht (Guthaben). Der Browser ignoriert die Antwort „ueberholt“ (er hat dann schon neu gestartet).
    const startNr = roh.avatarStartNr = (roh.avatarStartNr || 0) + 1;
    let browserWeg = false;
    res.on('close', () => { if (!res.writableEnded) browserWeg = true; });
    const ueberholt = () => browserWeg || wirdBeendet || roh.avatarStartNr !== startNr || ![...sessions.values()].includes(roh);
    const behalteOderLoesche = (av) => {
      if (!ueberholt()) { stoppeAvatar(roh); roh.avatar = av; return true; }
      loescheDidSitzung(av);
      console.log('Avatar: überholter Verbindungsaufbau – D-ID-Sitzung sofort wieder gelöscht.');
      sendJson(res, 409, { fehler: 'Der Verbindungsaufbau wurde durch einen neueren ersetzt.', code: 'ueberholt' });
      return false;
    };
    const profilSpr = profilSprache(roh.username);
    const leer = b.avatarId === undefined || b.avatarId === null || b.avatarId === '';
    let wunsch = leer ? (studioAgentId(profilSpr) ? 'studio-' + studioAgentId(profilSpr) : AVATAR_STANDARD) : b.avatarId;
    // Gruppen-Avatar (z. B. „mitano“): Sprache aus der Anfrage (sonst Profilsprache, sonst erste Sprache der Gruppe)
    // wählt den passenden D-ID-Agenten dieser Sprache. Die gewählte Sprache wird zur Profilsprache.
    let gruppenSprache = null;
    const gruppe = typeof wunsch === 'string' ? avatarGruppen().get(wunsch.toLowerCase()) : null;
    if (gruppe) {
      const gefragt = b.sprache === undefined || b.sprache === null || b.sprache === '' ? null : leseSprache(b.sprache);
      if (b.sprache && !gefragt) return sendJson(res, 400, { fehler: 'Diese Sprache gibt es nicht. Bitte eine Sprache aus der Liste wählen.' });
      gruppenSprache = gefragt && gruppe.agenten[gefragt] ? gefragt : gruppe.agenten[profilSpr] ? profilSpr : gruppe.sprachen[0];
      if (gefragt && !gruppe.agenten[gefragt]) return sendJson(res, 400, { fehler: 'In dieser Sprache gibt es den Avatar noch nicht.' });
      wunsch = 'studio-' + gruppe.agenten[gruppenSprache];
      // Gewählte Stimme (Profil) → Stimm-Variante dieser Sprache, falls vorhanden.
      const st = profilStimme(roh.username);
      if (st !== 'standard' && gruppe.stimmen?.[st]?.[gruppenSprache]) wunsch = 'studio-' + gruppe.stimmen[st][gruppenSprache];
      if (gruppenSprache !== profilSpr) {
        profile.set(roh.username, { ...(profile.get(roh.username) || {}), sprache: gruppenSprache });
        speichereProfile();
      }
    }

    // D-ID-Studio-Agent (Gesicht + Stimme). Nur Agent-IDs aus der Konfiguration (.env) sind erlaubt.
    // Alte Form „studio-de“ = erster Agent dieser Sprache.
    if (typeof wunsch === 'string' && wunsch.startsWith('studio-')) {
      const teil = wunsch.slice('studio-'.length);
      let sprache = null, agentId = null;
      if (Object.hasOwn(SPRACHEN, teil)) { sprache = teil; agentId = studioAgentId(teil); }
      else {
        const eintrag = studioAvatare().find((a) => a.id === teil);
        // Profilsprache, wenn der Avatar sie kann – sonst seine erste Sprache.
        sprache = eintrag ? (gruppenSprache && eintrag.sprachen.includes(gruppenSprache) ? gruppenSprache
          : eintrag.sprachen.includes(profilSpr) ? profilSpr : eintrag.sprachen[0]) : null;
        agentId = eintrag ? teil : null;
      }
      if (!agentId) return sendJson(res, 400, { fehler: 'Diesen Avatar gibt es nicht. Bitte einen Avatar aus der Liste wählen.' });
      stoppeAvatar(roh);
      // Technik (V1/V2) steht im Agent (presenter.type). Die Agent-Daten sind meist schon im Zwischenspeicher
      // (Avatar-Liste), daher kostet das kaum Zeit.
      const vorab = await studioAgent(agentId);
      if (didTechnik(vorab) === 'v2') {
        // Agents Streams V2: normale (interaktive) Sitzung, kein „echo“. Hybrid-Gespräch (hybrid: true, wenn der Agent
        // eine eigene KI hat): Smalltalk beantwortet der D-ID-Agent selbst (Browser schickt „lk.chat“), Fragen zu
        // Unterlagen/Medizin beantwortet Claude (Browser schickt die Sätze als „did.speak“). Entscheidung: /api/gespraech/weg.
        const sitzung = await did('POST', `/v2/agents/${encodeURIComponent(agentId)}/sessions`, {});
        if (!sitzung?.id || typeof sitzung.session_token !== 'string' || !LIVEKIT_HOST.test(String(sitzung.session_url || ''))) {
          if (sitzung?.id) did('DELETE', `/v2/agents/sessions/${encodeURIComponent(sitzung.id)}`).catch(() => {});
          throw kiFehler(502, 'D-ID hat keine passenden Verbindungsdaten geliefert.');
        }
        const zeig = studioDarstellung(vorab, sprache, agentId);
        if (!behalteOderLoesche({ technik: 'v2', agentId, sessionId: sitzung.id, typ: 'studio', avatarId: zeig.id, sprache })) return;
        const antwort = {
          technik: 'v2', sessionUrl: sitzung.session_url, sessionToken: sitzung.session_token,
          unterbrechenErlaubt: sitzung.interrupt_enabled !== false,
          bild: zeig.bild, anbieter: GESPRAECH_ANBIETER,
          avatar: { id: gruppe ? gruppe.name : zeig.id, name: zeig.name, bild: zeig.bild, typ: 'studio', technik: 'v2' },
          sprache, hybrid: !!vorab.llm,
          presenterTyp: vorab.presenter?.type === 'expressive' ? 'expressive' : 'image',   // für den Lippensync-Abgleich im Browser
        };
        const leerlauf = urlMit(vorab.presenter?.idle_video, STUDIO_VIDEO_HOST);
        if (leerlauf) antwort.leerlaufVideo = leerlauf;
        return sendJson(res, 200, antwort);
      }
      // Agent-Daten und Stream gleichzeitig holen bzw. anlegen. Kein D-ID-Chat mehr: das Gespräch läuft über Claude,
      // D-ID spricht nur noch den Text (avatarSprichText) → schnelleres Verbinden.
      // Kein „session_timeout“: D-ID lehnt Werte über 120 s für unseren Plan ab (403), der Standard (~150 s) ist länger.
      const [agentErg, streamErg] = await Promise.allSettled([
        studioAgent(agentId),
        did('POST', `/agents/${encodeURIComponent(agentId)}/streams`, { stream_warmup: true, compatibility_mode: 'auto' }),
      ]);
      const s = streamErg.status === 'fulfilled' ? streamErg.value : null;
      const offer = s && (s.offer || s.jsep);
      let fehler = null;
      if (streamErg.status === 'rejected') fehler = streamErg.reason;
      else if (!s.id || !offer) fehler = kiFehler(502, 'D-ID hat keine Verbindungsdaten geliefert.');
      else if (agentErg.status === 'rejected') fehler = agentErg.reason;
      if (fehler) {
        // Angelegten Stream nicht offen lassen (Guthaben)
        if (s && s.id) {
          did('DELETE', `/agents/${encodeURIComponent(agentId)}/streams/${encodeURIComponent(s.id)}`, { session_id: s.session_id }).catch(() => {});
        }
        throw fehler;
      }
      const agent = agentErg.value;
      const zeig = studioDarstellung(agent, sprache, agentId);
      if (!behalteOderLoesche({ agentId, streamId: s.id, sessionId: s.session_id, typ: 'studio', avatarId: zeig.id, sprache })) return;
      const antwort = {
        offer, ice_servers: s.ice_servers || [], bild: zeig.bild, anbieter: GESPRAECH_ANBIETER,
        avatar: { id: zeig.id, name: zeig.name, bild: zeig.bild, typ: 'studio' },
      };
      const leerlauf = urlMit(agent.presenter?.idle_video, STUDIO_VIDEO_HOST);
      if (leerlauf) antwort.leerlaufVideo = leerlauf;
      return sendJson(res, 200, antwort);
    }

    const avatar = AVATARE.find((a) => a.id === wunsch);
    if (!avatar) return sendJson(res, 400, { fehler: 'Diesen Avatar gibt es nicht. Bitte einen Avatar aus der Liste wählen.' });
    stoppeAvatar(roh);
    const agentId = await didAgent(avatar);
    const s = await did('POST', `/agents/${encodeURIComponent(agentId)}/streams`, { stream_warmup: true, compatibility_mode: 'auto' });
    const offer = s.offer || s.jsep;
    if (!s.id || !offer) {
      if (s.id) loescheDidSitzung({ agentId, streamId: s.id, sessionId: s.session_id });
      throw kiFehler(502, 'D-ID hat keine Verbindungsdaten geliefert.');
    }
    if (!behalteOderLoesche({ agentId, streamId: s.id, sessionId: s.session_id, stimme: avatar.stimme, avatarId: avatar.id })) return;
    const antwort = {
      offer, ice_servers: s.ice_servers || [], bild: avatar.bild, anbieter: DID_ANBIETER,
      avatar: { id: avatar.id, name: avatar.name, bild: avatar.bild, typ: 'eigen' },
    };
    const leerlauf = await didLeerlauf(agentId);
    if (leerlauf) antwort.leerlaufVideo = leerlauf;
    return sendJson(res, 200, antwort);
  }
  if (route === 'POST /api/avatar/sdp') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const a = b.answer;
    if (!a || a.type !== 'answer' || typeof a.sdp !== 'string') return sendJson(res, 400, { fehler: 'Ungültige Verbindungsdaten.' });
    const { av, pfad } = basis();
    await did('POST', pfad + '/sdp', { answer: { type: 'answer', sdp: a.sdp }, session_id: av.sessionId });
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/avatar/ice') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const { av, pfad } = basis();
    const daten = { session_id: av.sessionId };
    if (typeof b.candidate === 'string' && b.candidate) {
      daten.candidate = b.candidate;
      daten.sdpMid = typeof b.sdpMid === 'string' ? b.sdpMid : '0';
      daten.sdpMLineIndex = Number.isInteger(b.sdpMLineIndex) ? b.sdpMLineIndex : 0;
    }
    await did('POST', pfad + '/ice', daten);
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/avatar/sprechen') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length < 3) return sendJson(res, 400, { fehler: 'Bitte mindestens 3 Zeichen eingeben.' });
    if (text.length > MAX_SPRECHTEXT) return sendJson(res, 400, { fehler: `Der Text ist zu lang (höchstens ${MAX_SPRECHTEXT.toLocaleString('de-DE')} Zeichen).` });
    const sprache = leseSprache(b.sprache);
    if (!sprache) return sendJson(res, 400, { fehler: 'Diese Sprache gibt es nicht. Bitte eine Sprache aus der Liste wählen.' });
    basis();
    const dauer = await avatarSprichText(roh, text, sprache);
    return sendJson(res, 200, { ok: true, dauer, sprache });
  }
  if (route === 'POST /api/avatar/gespraech') {
    const t0 = Date.now();
    const b = (await readJson(req, MAX_BODY_GESPRAECH)) || {};
    let nachricht = typeof b.nachricht === 'string' ? b.nachricht.trim() : '';
    if (!nachricht) return sendJson(res, 400, { fehler: 'Es wurde nichts verstanden. Bitte noch einmal sprechen.' });
    if (nachricht.length > MAX_NACHRICHT) return sendJson(res, 400, { fehler: `Die Nachricht ist zu lang (höchstens ${MAX_NACHRICHT} Zeichen).` });
    // Nur für Messungen ohne D-ID (zweiter Prozess, .env bleibt unberührt): TEST_TEXTWEG=1 erlaubt den Text-Strom ohne Avatar.
    const textTest = process.env.TEST_TEXTWEG === '1' && b.strom === true && !roh.avatar;
    // Ist für die Profilsprache ein Studio-Avatar eingerichtet, soll die App erst (neu) verbinden statt nur Text zu zeigen.
    if (!roh.avatar && !textTest && studioAgentId(profilSprache(roh.username))) {
      return sendJson(res, 409, { fehler: 'Der Avatar ist nicht verbunden.', code: 'nicht_verbunden' });
    }
    let sprache = leseSprache(b.sprache);
    if (roh.avatar?.typ === 'studio') {
      // Studio-Avatar: Profilsprache, wenn der Avatar sie kann – sonst die Sprache, mit der er verbunden wurde.
      const ps = profilSprache(roh.username);
      sprache = (studioAvatare().find((a) => a.id === roh.avatar.agentId)?.sprachen || []).includes(ps) ? ps : roh.avatar.sprache;
    }
    if (!sprache) return sendJson(res, 400, { fehler: 'Diese Sprache gibt es nicht. Bitte eine Sprache aus der Liste wählen.' });

    // Gedächtnis: Verlauf der Sitzung im Arbeitsspeicher. Nur wenn der Server noch nichts hat (z. B. nach Neustart),
    // wird der vom Client mitgeschickte Verlauf genommen.
    if (!Array.isArray(roh.protokoll)) roh.protokoll = [];
    const clientVerlauf = (Array.isArray(b.verlauf) ? b.verlauf : [])
      .filter((v) => v && (v.rolle === 'nutzer' || v.rolle === 'avatar') && typeof v.text === 'string' && v.text.trim())
      .map((v) => ({ rolle: v.rolle, text: v.text.slice(0, 4000) }));
    const verlauf = (roh.protokoll.length ? roh.protokoll : clientVerlauf).slice(-MAX_VERLAUF);

    const stand = gespraechStand();
    const dokumente = ladeKontext(roh.username);
    const patientId = patientVon(roh.username);
    const sitzungAbgelaufen = (e) => e && (e.didArt === 'SessionError' || e.didStatus === 404);
    // V2-Avatar (LiveKit): Der Browser spricht. Mit „strom: true“ liefert der Server die Sätze als
    // Server-Sent-Events, sobald Claude sie fertig hat (event „satz“), am Ende „fertig“ bzw. „fehler“.
    // Sofort-Lesen: „Ja“ direkt nach der Ansage zu einer neuen Unterlage → genau dieses Dokument erklären.
    const af = roh.ansageFokus; roh.ansageFokus = null;
    if (af && Date.now() - af.seit < OFFENER_REST_MS && willMehr(nachricht)) {
      nachricht = `Bitte erklär mir kurz in einfachen Worten meine neue Unterlage${af.titel ? ` „${af.titel}“` : ''}.`;
      roh.letzteQuellenDocs = [af.docId];
      roh.offenerRest = null;
    }
    // Satzbremse: Ein gemerkter Rest gilt nur für die direkt folgende Nachricht.
    const offen = roh.offenerRest; roh.offenerRest = null;
    if (offen && roh.avatar?.technik === 'v2' && b.strom === true && Date.now() - offen.seit < OFFENER_REST_MS && willMehr(nachricht)) {
      return restStrom(res, roh, offen, { nachricht, t0 });
    }
    if ((roh.avatar?.technik === 'v2' || textTest) && b.strom === true) {
      return gespraechStrom(res, roh, { nachricht, verlauf, stand, dokumente, sprache, t0, patientId });
    }
    let antwort, sprechAuftraege = 0, ersterAuftragMs = null, ki = null, wissen = null;
    let browserWeg = false;   // Browser hat abgebrochen → keine weiteren Sprechaufträge an D-ID
    res.on('close', () => { if (!res.writableEnded) browserWeg = true; });
    const sprich = async (text) => {
      const t = ohneMarkdown(text).slice(0, MAX_SPRECHTEXT);
      if (!t || browserWeg || !roh.avatar || roh.avatar.technik === 'v2') return;   // V2: spricht der Browser
      if (ersterAuftragMs === null) ersterAuftragMs = Date.now() - t0;
      await avatarSprichText(roh, t, sprache);
      sprechAuftraege++;
    };

    let ersterSatz = null;   // Promise des ersten Sprechauftrags (nur bei satzweisem Sprechen)
    roh.kriseLetzte = null;
    const krise = stand.bereit ? await istKrise(roh, nachricht, GEFUEHL_RE.test(nachricht)) : null;
    const appFrage = !krise && istAppFrage(nachricht);
    const gedaechtnis = appFrage ? { text: '', fakten: [] } : gedaechtnisFuer(patientId, nachricht);
    if (krise) gedaechtnis.text = [gedaechtnis.text, krisenHinweis(krise)].filter(Boolean).join('\n\n');
    if (!appFrage) { const dk = await dashboardKontext(patientId, nachricht); if (dk) gedaechtnis.text = [gedaechtnis.text, dk].filter(Boolean).join('\n\n'); }
    try {
      // Test-Patient zugeordnet → Antwort aus dessen Unterlagen mit Quellen. Erster Satz geht sofort an D-ID, der Rest danach.
      if (stand.bereit && patientId && !appFrage) {
        const rest = [];
        const sofort = SATZWEISE_SPRECHEN && roh.avatar && roh.avatar.technik !== 'v2';
        wissen = await ragAntwort({
          patientId, nachricht, verlauf, stand, sprache, fokusDocs: roh.letzteQuellenDocs || [], gedaechtnis,
          beiSatz: sofort ? (satz) => { if (!ersterSatz) { ersterSatz = sprich(satz); ersterSatz.catch(() => {}); } else rest.push(satz); } : null,
        });
        if (wissen) {
          roh.letzteQuellenDocs = [...new Set(wissen.quellen.map((q) => q.docId))].slice(0, 3);
          antwort = ohneMarkdown(wissen.text);
          if (ersterSatz) { await ersterSatz; if (rest.length) await sprich(rest.join(' ')); }
          else await sprich(wissen.text);
        }
      }
      if (wissen) {
        // schon erledigt
      } else if (stand.bereit) {
        const beiErstemSatz = SATZWEISE_SPRECHEN && roh.avatar && roh.avatar.technik !== 'v2' ? (satz) => { ersterSatz = sprich(satz); ersterSatz.catch(() => {}); } : null;
        ki = await kiAntwortStream(baueSystem(stand.systemprompt, dokumente, sprache, gedaechtnis.text), baueNachrichten(verlauf, nachricht), stand.modell, beiErstemSatz);
        antwort = ohneMarkdown(ki.text);
        if (ersterSatz) {
          await ersterSatz;                                   // erst wenn D-ID den ersten Auftrag angenommen hat …
          await sprich(ki.text.slice(ki.satzEnde));           // … den Rest hinterherschicken
        } else {
          await sprich(ki.text);
        }
      } else {
        antwort = SPRACHEN[sprache].echo + nachricht;
        await sprich(antwort);
      }
    } catch (e) {
      // D-ID-Sitzung abgelaufen und noch nichts gesprochen → App verbindet still neu und schickt die Nachricht erneut.
      // Verlauf bleibt unverändert, damit die Nachricht nicht doppelt im Gedächtnis landet.
      if (sitzungAbgelaufen(e) && sprechAuftraege === 0) {
        roh.avatar = null;
        console.log('Gespräch: D-ID-Sitzung war abgelaufen, App verbindet neu.');
        return sendJson(res, 409, { fehler: 'Die Verbindung zum Avatar war abgelaufen.', code: 'sitzung_abgelaufen' });
      }
      if (!(sprechAuftraege > 0 && antwort)) throw e;
      console.log('Gespräch: zweiter Sprechauftrag fehlgeschlagen (erster wurde gesprochen).');
    }

    const zeit = new Date().toISOString();
    roh.protokoll.push({ rolle: 'nutzer', text: nachricht, zeit }, { rolle: 'avatar', text: antwort, zeit: new Date().toISOString() });
    if (roh.protokoll.length > MAX_PROTOKOLL) roh.protokoll.splice(0, roh.protokoll.length - MAX_PROTOKOLL);
    if (stand.bereit && !krise) lerneImHintergrund(patientId, nachricht, antwort, sprache);

    const dauerMs = ersterAuftragMs ?? (Date.now() - t0);
    // Log nur mit Zahlen – nie Nachricht, Antwort oder Dokumentnamen.
    console.log(`Gespräch: ${wissen ? 'Wissensspeicher' : stand.bereit ? 'KI' : 'Echo'}, Patient ${patientId || '–'}, ${dokumente.length} Dok., bis Sprechen ${dauerMs} ms` +
      (wissen ? `, Suche ${wissen.zeiten.erweiterungMs + wissen.zeiten.sucheMs} ms (${wissen.suchbegriffe.length} Zusatzbegriffe), erster Text ${wissen.zeiten.ersteTextMs} ms, ${wissen.quellen.length} Quellen` : '') +
      (ki ? `, erster Text ${ki.ersteTextMs} ms, KI gesamt ${ki.gesamtMs} ms, Cache gelesen ${ki.cacheGelesen}/geschrieben ${ki.cacheGeschrieben} Tokens` : '') +
      `, ${sprechAuftraege} Sprechauftrag/-aufträge`);
    return sendJson(res, 200, {
      antwort, gesprochen: sprechAuftraege > 0, sprechAuftraege, sprache,
      modus: stand.bereit ? 'ki' : 'echo',
      modell: stand.bereit ? stand.modell : null,
      dauerMs, dauerGesamtMs: Date.now() - t0,
      anbieter: stand.bereit ? GESPRAECH_ANBIETER : null,
      kontextDokumente: dokumente.length,
      hinweis: stand.grund,
      quelle: stand.quelle,
      patientId: wissen ? patientId : null,
      quellen: wissen ? quellenSicht(wissen.quellen) : [],
      antwortMitMarkern: wissen ? wissen.textMitMarkern : null,
      gedaechtnisQuellen: stand.bereit ? gedaechtnisQuellen(wissen ? wissen.gedaechtnisFakten : gedaechtnis.fakten, antwort) : [],
      ...(appFrage ? { zeigeKnoepfe: knoepfeIn(antwort) } : {}),
      ...((krise || KRISEN_ARTEN.includes(roh.kriseLetzte?.ergebnis)) ? { krise: krise || roh.kriseLetzte.ergebnis, hilfe: krisenHilfe(krise || roh.kriseLetzte.ergebnis, sprache) } : {}),
    });
  }
  if (route === 'POST /api/avatar/stop') {
    stoppeAvatar(roh);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  // Gesundheits-Route für den Wächter: ohne Anmeldung, ohne Bremse, nur Zustand (keine Inhalte).
  if (url.pathname === '/api/gesundheit' && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendJson(res, wirdBeendet ? 503 : 200, { ok: !wirdBeendet, version: VERSION, laufzeit: Math.round((Date.now() - START_ZEIT) / 1000) });
  }
  const ip = clientIp(req);
  const route = `${req.method} ${url.pathname}`;
  const topf = route === 'POST /api/login' ? 'login' : route === 'POST /api/avatar/start' ? 'avatarStart' : KI_ROUTEN.has(route) ? 'ki' : null;
  const warten = tooManyRequests('api', ip) || (topf ? tooManyRequests(topf, ip) : 0);
  if (warten) {
    res.setHeader('Retry-After', String(warten));
    return sendJson(res, 429, { fehler: 'Zu viele Anfragen. Bitte kurz warten.' });
  }

  const changing = req.method !== 'GET' && req.method !== 'HEAD';
  // Schutz gegen fremde Webseiten: Änderungen nur mit eigenem Kopfzeilenfeld und JSON.
  if (changing && (req.headers['x-requested-with'] !== 'akki-app' ||
      !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return sendJson(res, 403, { fehler: 'Anfrage nicht erlaubt.' });
  }

  const sess = getSession(req);

  if (route === 'POST /api/login') {
    const b = await readJson(req);
    const username = String(b.username || '').toLowerCase().trim();
    const password = String(b.password || '');
    if (b.consent !== true) return sendJson(res, 400, { fehler: 'Bitte zuerst den Datenschutz-Hinweis bestätigen.' });

    const key = `${ip}|${username}`;
    const f = fails.get(key);
    if (f && f.until && Date.now() < f.until) {
      return sendJson(res, 429, { fehler: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
    }
    const user = users.find((u) => u.username === username);
    if (password.length <= 200 && await checkPassword(user, password)) {
      fails.delete(key);
      // Pitch-Demo: DEMO_USER durchläuft die Einrichtung (Avatar + Sprache) bei jeder Anmeldung.
      if (istNutzer(user.username, 'DEMO_USER')) {
        profile.set(user.username, { ...(profile.get(user.username) || {}), eingerichtet: false });
        speichereProfile();
      }
      startSession(req, res, user);
      return sendJson(res, 200, { username: user.username, role: user.role });
    }
    const n = (f ? f.count : 0) + 1;
    fails.set(key, { count: n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0, zeit: Date.now() });
    return sendJson(res, 401, { fehler: 'Anmeldung nicht möglich. Bitte Eingaben prüfen.' });
  }

  if (route === 'GET /api/me') {
    return sess ? sendJson(res, 200, { username: sess.username, role: sess.role })
                : sendJson(res, 401, { fehler: 'Nicht angemeldet.' });
  }

  if (!sess) return sendJson(res, 401, { fehler: 'Nicht angemeldet.' });

  if (route === 'POST /api/logout') {
    beendeSitzung(sess.token); speichereSitzungen(); setCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  // Profil: Sprache des Nutzers. Pro Sprache gibt es (später) einen eigenen D-ID-Studio-Agent.
  if (url.pathname === '/api/profil') {
    if (req.method === 'GET') return sendJson(res, 200, profilAntwort(sess.username));
    if (req.method === 'PUT') {
      const b = (await readJson(req)) || {};
      const neu = {};
      if (b.sprache !== undefined) {
        if (typeof b.sprache !== 'string' || !Object.hasOwn(SPRACHEN, b.sprache)) {
          return sendJson(res, 400, { fehler: 'Diese Sprache gibt es nicht. Bitte eine Sprache aus der Liste wählen.' });
        }
        if (!studioAgentId(b.sprache)) return sendJson(res, 400, { fehler: 'Für diese Sprache ist noch kein Avatar eingerichtet.' });
        neu.sprache = b.sprache;
      }
      if (b.avatarId !== undefined) {
        if (typeof b.avatarId !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(b.avatarId)) return sendJson(res, 400, { fehler: 'Unbekannter Avatar.' });
        neu.avatarId = b.avatarId;
      }
      if (b.eingerichtet !== undefined) neu.eingerichtet = b.eingerichtet === true;
      if (b.stimme !== undefined) {
        const bekannt = b.stimme === 'standard' || [...avatarGruppen().values()].some((g) => g.stimmen?.[b.stimme]);
        if (!gueltigeStimme(b.stimme) || !bekannt) return sendJson(res, 400, { fehler: 'Diese Stimme gibt es nicht.' });
        neu.stimme = b.stimme;
      }
      if (!Object.keys(neu).length) return sendJson(res, 400, { fehler: 'Nichts zu ändern.' });
      profile.set(sess.username, { ...(profile.get(sess.username) || {}), ...neu });
      speichereProfile();
      return sendJson(res, 200, profilAntwort(sess.username));
    }
    return sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
  }

  // Stimmen zur Auswahl (Einstellungen): für den Avatar und die Sprache des Profils.
  if (route === 'GET /api/stimmen') {
    const sprache = profilSprache(sess.username);
    const gruppe = avatarGruppen().get(String(profilAvatar(sess.username) || '').toLowerCase()) || [...avatarGruppen().values()][0] || null;
    const stimmen = await stimmenListe(gruppe, sprache);
    const st = profilStimme(sess.username);
    return sendJson(res, 200, { sprache, stimme: stimmen.some((x) => x.id === st) ? st : 'standard', stimmen });
  }

  if (route === 'GET /api/avatare') {
    const sprache = profilSprache(sess.username);
    const gruppen = [...avatarGruppen().values()];
    if (gruppen.length) {
      // Gruppen-Avatare (z. B. „mitano“): EIN Eintrag mit allen Sprachen; die Sprache wird beim Start gewählt.
      // Einzelne Agents ohne Gruppe erscheinen daneben, wenn sie die Profilsprache können.
      const einzel = studioAvatare().filter((a) => !a.gruppe && a.sprachen.includes(sprache)).map((a) => a.id);
      const erg = await Promise.allSettled([
        ...gruppen.map((g) => studioAgent(g.agenten[g.sprachen[0]])),   // Name/Bild vom ersten Sprach-Agenten (z. B. „mitano.“)
        ...einzel.map((id) => studioAgent(id)),
      ]);
      const avatare = [];
      gruppen.forEach((g, i) => {
        if (erg[i].status !== 'fulfilled') return;
        const zeig = studioDarstellung(erg[i].value, sprache, g.agenten[g.sprachen[0]]);
        avatare.push({ ...zeig, id: g.name, gruppe: true, sprachen: g.sprachen,
          sprachNamen: g.sprachen.map((id) => ({ id, name: SPRACHEN[id].name })) });
      });
      einzel.forEach((id, j) => { const e = erg[gruppen.length + j]; if (e.status === 'fulfilled') avatare.push(studioDarstellung(e.value, sprache, id)); });
      if (!avatare.length) {
        const e = erg[0].reason || {};
        return sendJson(res, e.status || 502, { fehler: e.meldung || 'Die Avatare konnten nicht geladen werden.' });
      }
      return sendJson(res, 200, { avatare, standard: avatare[0].id, sprache });
    }
    const ids = studioAgentIds(sprache);
    if (ids.length) {
      // Alle Studio-Avatare der Profilsprache gleichzeitig laden; nicht ladbare werden weggelassen.
      const erg = await Promise.allSettled(ids.map((id) => studioAgent(id)));
      const avatare = ids.map((id, i) => (erg[i].status === 'fulfilled' ? studioDarstellung(erg[i].value, sprache, id) : null)).filter(Boolean);
      if (!avatare.length) {
        const e = erg[0].reason || {};
        return sendJson(res, e.status || 502, { fehler: e.meldung || 'Die Avatare konnten nicht geladen werden.' });
      }
      if (avatare.length < ids.length) console.log(`Avatare: ${ids.length - avatare.length} Studio-Agent(s) nicht ladbar.`);
      const std = 'studio-' + studioAgentId(sprache);
      return sendJson(res, 200, { avatare, standard: avatare.some((a) => a.id === std) ? std : avatare[0].id, sprache });
    }
    // Ohne Studio-Agent: unsere eigenen Avatare ohne KI (Gespräch dann über Claude bzw. Echo-Test).
    return sendJson(res, 200, {
      avatare: AVATARE.map(({ id, name, bild, beschreibung, stimme, sprachen }) => ({ id, name, bild, beschreibung, stimme, sprachen, typ: 'eigen' })),
      standard: AVATAR_STANDARD,
      sprache,
      sprachen: Object.entries(SPRACHEN).map(([id, s]) => ({ id, name: s.name })),
      spracheStandard: SPRACHE_STANDARD,
    });
  }

  // Gesprächs-Einstellungen: Anweisung für Claude (App-Anweisung, gilt für ALLE Nutzer). Ändern nur Admins.
  // Inhalt wird nie geloggt.
  if (url.pathname === '/api/gespraech/einstellungen') {
    const darfAendern = sess.role === 'admin';
    const antwort = () => sendJson(res, 200, { ...gespraechStand(), darfAendern });
    if (req.method === 'GET') return antwort();
    if (req.method !== 'PUT' && req.method !== 'DELETE') return sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
    if (!darfAendern) return sendJson(res, 403, { fehler: 'Nur Administratoren dürfen die Anweisung des Avatars ändern.' });
    if (req.method === 'PUT') {
      const b = (await readJson(req, 128 * 1024)) || {};
      if (typeof b.systemprompt !== 'string') return sendJson(res, 400, { fehler: 'Bitte die Anweisung als Text senden.' });
      const text = b.systemprompt.replace(/\u0000/g, '').trim();   // leer = zurück zur Datei prompt/gespraech.md
      if (text.length > MAX_SYSTEMPROMPT) {
        return sendJson(res, 400, { fehler: `Die Anweisung ist zu lang (höchstens ${MAX_SYSTEMPROMPT.toLocaleString('de-DE')} Zeichen).` });
      }
      setzeAppAnweisung(text);
      console.log(`Gespräch: App-Anweisung ${text ? 'geändert' : 'zurückgesetzt'}.`);
      return antwort();
    }
    setzeAppAnweisung('');
    console.log('Gespräch: App-Anweisung zurückgesetzt.');
    return antwort();
  }

  // Hybrid-Gespräch: Weiche „nativ“ (D-ID-Agent) oder „claude“ (Unterlagen). Nachricht wird nicht gespeichert/geloggt.
  if (route === 'POST /api/gespraech/weg') {
    const roh = sessions.get(sess.token);
    const b = (await readJson(req, MAX_BODY_GESPRAECH)) || {};
    const nachricht = typeof b.nachricht === 'string' ? b.nachricht.trim() : '';
    if (!nachricht) return sendJson(res, 400, { fehler: 'Es wurde nichts verstanden. Bitte noch einmal sprechen.' });
    if (nachricht.length > MAX_NACHRICHT) return sendJson(res, 400, { fehler: `Die Nachricht ist zu lang (höchstens ${MAX_NACHRICHT} Zeichen).` });
    const sprache = roh.avatar?.sprache || leseSprache(b.sprache) || profilSprache(sess.username);
    const patientId = patientVon(sess.username);
    let titel = [];
    try { if (patientId) titel = rag.ladePatient(patientId).dokumente.map((d) => [d.titel, d.datum].filter(Boolean).join(' ')); } catch {}
    titel = [...titel, ...ladeKontext(sess.username).map((d) => d.name)];
    if (roh.ansageFokus && Date.now() - roh.ansageFokus.seit < OFFENER_REST_MS && willMehr(nachricht)) {
      console.log('Weg: claude (neue Unterlage erklären) in 0 ms');
      return sendJson(res, 200, { weg: 'claude', grund: 'unterlagen', quelle: 'vorfilter', ms: 0, sprache, ueberbrueckung: ueberbrueckung(sprache, 'unterlagen') });
    }
    if (roh.offenerRest && Date.now() - roh.offenerRest.seit < OFFENER_REST_MS && willMehr(nachricht)) {
      console.log('Weg: claude (offener Rest) in 0 ms');
      return sendJson(res, 200, { weg: 'claude', grund: 'mehr', quelle: 'vorfilter', ms: 0, sprache, ueberbrueckung: null });
    }
    let gedaechtnisDa = false;
    try { if (patientId) gedaechtnisDa = gd.exportiere(patientId).anzahl.gespraech > 0; } catch {}
    // Spekulativer Start: Suchbegriffe + Claude-Antwort laufen schon parallel zur Weiche (nicht bei Gefühl/Krise/App).
    verwirfSpekulation(roh);
    roh.suchVorlauf = null;
    const stand0 = gespraechStand();
    const spekulieren = spekulativAn() && stand0.bereit && patientId && titel.length && Array.isArray(roh.protokoll)
      && !kriseStichwort(nachricht) && !GEFUEHL_RE.test(nachricht) && !istAppFrage(nachricht);
    if (spekulieren) {
      const vorfrage = [...(roh.protokoll || [])].reverse().find((v) => v.rolle === 'nutzer')?.text || '';
      roh.suchVorlauf = { nachricht, start: Date.now(), p: rag.erweitereAnfrage({ frage: nachricht, vorfrage, timeoutMs: 3500 }).catch(() => ({ begriffe: [] })) };
      const verlaufS = roh.protokoll.slice(-MAX_VERLAUF);
      const job = starteErzeugung(roh, { nachricht, verlauf: verlaufS, stand: stand0, dokumente: ladeKontext(sess.username), sprache, patientId,
        gedaechtnis: gedaechtnisFuer(patientId, nachricht) });
      job.timer = setTimeout(() => { if (roh.spekulation === job) verwirfSpekulation(roh); }, SPEKULATION_MAX_MS);
      roh.spekulation = job;
    }
    const w = await waehleWeg({ nachricht, verlauf: (roh.protokoll || []).slice(-6), titel, stand: stand0, patientId, gedaechtnisDa });
    if (roh.spekulation && (w.weg !== 'claude' || ['gefuehl', 'krise', 'app', 'mehr'].includes(w.grund))) verwirfSpekulation(roh);   // „nativ“ u. a.: abbrechen
    // Laienwort/andere Sprache → deutsche Fachbegriffe für die Suche (Haiku), läuft WÄHREND der Überbrückungssatz
    // gesprochen wird; das Gespräch wartet höchstens SUCHBEGRIFFE_WARTE_MS darauf (sonst Suche wie bisher).
    if (!spekulieren && w.weg === 'claude' && patientId && titel.length && !['app', 'mehr'].includes(w.grund)) {
      const vorfrage = [...(roh.protokoll || [])].reverse().find((v) => v.rolle === 'nutzer')?.text || '';
      const p = rag.erweitereAnfrage({ frage: nachricht, vorfrage, timeoutMs: 3500 }).catch(() => ({ begriffe: [] }));
      roh.suchVorlauf = { nachricht, start: Date.now(), p };
    }
    // Krise: Haiku-Weiche hat schon geprüft (quelle 'ki'); bei Vorfilter-Wegen zur Sicherheit im Hintergrund prüfen.
    roh.kriseVorlauf = null;
    if (w.grund !== 'krise' && w.weg === 'claude' && w.quelle !== 'ki' && !['app', 'mehr'].includes(w.grund)) {
      const k = { nachricht, start: Date.now(), p: null };
      k.p = pruefeKrise(nachricht).then((x) => { k.ergebnis = x; return x; });
      roh.kriseVorlauf = k;
    }
    if (w.grund === 'krise') {
      roh.kriseVorlauf = { nachricht, start: Date.now(), ergebnis: w.krise };
      console.log('Weg: claude (krise)');
      return sendJson(res, 200, { ...w, sprache, ueberbrueckung: ueberbrueckung(sprache, 'krise'), krise: w.krise, hilfe: krisenHilfe(w.krise, sprache) });
    }
    console.log(`Weg: ${w.weg} (${w.quelle}, ${w.grund}) in ${w.ms} ms`);
    return sendJson(res, 200, { ...w, sprache, ueberbrueckung: w.weg === 'claude' ? ueberbrueckung(sprache, w.grund) : null });
  }
  // Nativer Weg: Frage + Antwort des D-ID-Agenten (Text aus den D-ID-Ereignissen) ins Sitzungsprotokoll,
  // damit Claude später den Faden kennt. Nur Arbeitsspeicher, nie geloggt.
  // Freihändiges Gespräch: Patient hat mitano. unterbrochen. Läuft gerade eine Claude-Antwort, wird sie beim Speichern
  // markiert; sonst die letzte gespeicherte Antwort. Es werden keine Inhalte übertragen.
  if (route === 'POST /api/gespraech/unterbrochen') {
    const roh = sessions.get(sess.token);
    if (!Array.isArray(roh.protokoll)) roh.protokoll = [];
    roh.unterbrochenUm = Date.now();
    if (!roh.stromLaeuftSeit) {
      const letzte = [...roh.protokoll].reverse().find((v) => v.rolle === 'avatar');
      if (letzte && !letzte.text.endsWith(UNTERBROCHEN_MARKE)) letzte.text += UNTERBROCHEN_MARKE;
    }
    console.log('Gespräch: vom Patienten unterbrochen.');
    return sendJson(res, 200, { ok: true });
  }

  // Persönliche Begrüßung beim Verbinden (iOS/Browser spricht sie statt der D-ID-Standardbegrüßung).
  if (route === 'GET /api/gespraech/begruessung') {
    const roh = sessions.get(sess.token);
    const sprache = roh?.avatar?.sprache || profilSprache(sess.username);
    const pid = patientVon(sess.username);
    let name = null;
    try { if (pid) name = gd.steckbrief(pid).name; } catch {}
    return sendJson(res, 200, { text: begruessung(sprache, name), sprache, name, patientId: pid,
      wakewordHinweis: WAKEWORD_HINWEIS[sprache] || WAKEWORD_HINWEIS.de });
  }
  if (route === 'POST /api/gespraech/nativ') {
    const roh = sessions.get(sess.token);
    const b = (await readJson(req, MAX_BODY_GESPRAECH)) || {};
    const nachricht = typeof b.nachricht === 'string' ? b.nachricht.trim().slice(0, MAX_NACHRICHT) : '';
    const antwort = typeof b.antwort === 'string' ? b.antwort.trim().slice(0, 4000) : '';
    if (!nachricht) return sendJson(res, 400, { fehler: 'Nachricht fehlt.' });
    if (!Array.isArray(roh.protokoll)) roh.protokoll = [];
    const zeit = new Date().toISOString();
    roh.protokoll.push({ rolle: 'nutzer', text: nachricht, zeit, weg: 'nativ' });
    if (antwort) roh.protokoll.push({ rolle: 'avatar', text: antwort + (b.unterbrochen === true ? UNTERBROCHEN_MARKE : ''), zeit, weg: 'nativ' });
    if (roh.protokoll.length > MAX_PROTOKOLL) roh.protokoll.splice(0, roh.protokoll.length - MAX_PROTOKOLL);
    roh.offenerRest = null;   // neue Frage über den nativen Weg → gemerkter Rest verfällt
    if (gespraechStand().bereit) lerneImHintergrund(patientVon(sess.username), nachricht, antwort, roh.avatar?.sprache || profilSprache(sess.username));
    const z = (v) => (Number.isFinite(v) && v >= 0 && v < 120000 ? Math.round(v) + ' ms' : '–');
    console.log(`Gespräch (nativ): Ton nach ${z(b.tonMs)}, Antworttext ${antwort ? 'da' : 'fehlt'}`);
    return sendJson(res, 200, { ok: true });
  }

  // Protokoll des Gesprächs (nur diese Sitzung, nur Arbeitsspeicher). Löschen leert auch das Gedächtnis des Avatars.
  if (url.pathname === '/api/gespraech/protokoll') {
    const roh = sessions.get(sess.token);
    if (req.method === 'GET') return sendJson(res, 200, { eintraege: (roh.protokoll || []).map(({ rolle, text, zeit, weg }) => ({ rolle, text, zeit, weg: weg || 'claude' })) });
    if (req.method === 'DELETE') { roh.protokoll = []; roh.letzteQuellenDocs = []; return sendJson(res, 200, { eintraege: [] }); }
    return sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
  }

  // Kontext: Unterlagen hochladen, auflisten, löschen. Inhalte und Dateinamen werden nie geloggt.
  if (url.pathname === '/api/kontext' || url.pathname.startsWith('/api/kontext/')) {
    try {
      if (route === 'GET /api/kontext') return sendJson(res, 200, kontextListe(sess.username));
      if (route === 'DELETE /api/kontext') {
        entferneAusPatient(sess.username, ladeKontext(sess.username));
        speichereKontext(sess.username, []);
        console.log('Kontext: alle Dokumente gelöscht.');
        return sendJson(res, 200, kontextListe(sess.username));
      }
      if (req.method === 'DELETE') {
        const id = url.pathname.slice('/api/kontext/'.length);
        const dokumente = ladeKontext(sess.username);
        const rest = dokumente.filter((d) => d.id !== id);
        if (rest.length === dokumente.length) return sendJson(res, 404, { fehler: 'Dieses Dokument gibt es nicht (mehr).' });
        entferneAusPatient(sess.username, dokumente.filter((d) => d.id === id));
        speichereKontext(sess.username, rest);
        console.log('Kontext: ein Dokument gelöscht.');
        return sendJson(res, 200, kontextListe(sess.username));
      }
      if (route === 'POST /api/kontext') return await mitUploadPlatz(async () => {
        const b = (await readJson(req, MAX_BODY_KONTEXT)) || {};
        const typ = b.typ;
        if (!['text', 'bild', 'pdf'].includes(typ)) return sendJson(res, 400, { fehler: 'Unbekannte Art von Unterlage. Erlaubt sind Text, Bild (Foto/Scan) und PDF.' });
        const name = sichererName(b.name);
        const dokumente = ladeKontext(sess.username);
        if (dokumente.length >= MAX_KONTEXT_DOKUMENTE) {
          return sendJson(res, 413, { fehler: `Es sind schon ${MAX_KONTEXT_DOKUMENTE} Unterlagen hochgeladen. Bitte zuerst ältere löschen.` });
        }
        const belegt = dokumente.reduce((n, d) => n + d.text.length, 0);
        let text, mime = null, groesse;
        if (typ === 'text') {
          if (typeof b.inhalt !== 'string' || !b.inhalt.trim()) return sendJson(res, 400, { fehler: 'Der Text ist leer.' });
          text = b.inhalt.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
          groesse = Buffer.byteLength(text);
        } else {
          const daten = leseBase64(b.inhalt);
          if (!daten) return sendJson(res, 400, { fehler: 'Die Datei kam nicht richtig an (kein gültiges Base64). Bitte erneut versuchen.' });
          groesse = daten.bytes;
          if (typ === 'bild') {
            mime = String(b.mime || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(b.mime || '').toLowerCase();
            if (!BILD_MIMES.includes(mime)) return sendJson(res, 400, { fehler: 'Dieses Bildformat geht nicht. Erlaubt sind JPEG, PNG, GIF und WebP (iPhone-Fotos im HEIC-Format bitte als JPEG senden).' });
            if (daten.bytes > MAX_BILD_BYTES) return sendJson(res, 413, { fehler: 'Das Bild ist zu groß (höchstens 5 MB). Bitte das Foto verkleinern oder mit geringerer Qualität scannen.' });
          } else {
            mime = 'application/pdf';
            if (!daten.b64.startsWith('JVBER')) return sendJson(res, 400, { fehler: 'Die Datei ist kein PDF.' });
          }
          if (belegt >= MAX_KONTEXT_ZEICHEN) {
            return sendJson(res, 413, { fehler: `Die Unterlagen sind zusammen schon zu lang (höchstens ${MAX_KONTEXT_ZEICHEN.toLocaleString('de-DE')} Zeichen). Bitte zuerst ältere löschen.` });
          }
          text = await schreibeAb(typ, mime, daten.b64);
        }
        if (belegt + text.length > MAX_KONTEXT_ZEICHEN) {
          return sendJson(res, 413, { fehler: `Die Unterlagen wären zusammen zu lang (höchstens ${MAX_KONTEXT_ZEICHEN.toLocaleString('de-DE')} Zeichen, schon belegt: ${belegt.toLocaleString('de-DE')}). Bitte zuerst ältere Unterlagen löschen oder einen kürzeren Text wählen.` });
        }
        const dok = { id: crypto.randomBytes(8).toString('hex'), name, typ, mime, text, erstelltAm: new Date().toISOString() };
        // Ist ein Test-Patient zugeordnet: Unterlage direkt in seine Unterlagen (patientendaten.js: Typ foto + Seitenbild,
        // Suchindex für Quellenangaben, Zeitstrahl im Hintergrund) – nicht zusätzlich in den Sitzungs-Kontext.
        const patientId = patientVon(sess.username);
        if (patientId) {
          const bilder = typ === 'bild' && mime === 'image/jpeg' ? [leseBase64(b.inhalt).b64] : [];
          const r = pd.neu(patientId, { titel: b.name ? name : '', text, typ: typ === 'bild' ? 'foto' : 'upload', bilder });
          if (!r.doppelt) { zeitstrahlImHintergrund(patientId, r.dokument.docId); dokumentLernenImHintergrund(patientId, r.dokument.docId); ansageImHintergrund(patientId, r.dokument.docId, profilSprache(sess.username)); }
          console.log(`Kontext: Unterlage beim Test-Patienten gespeichert (${typ}).`);
          return sendJson(res, 201, { id: r.dokument.docId, name: r.dokument.titel, typ, zeichen: text.length, vorschau: vorschau(text),
            erstelltAm: r.dokument.erstelltAm, status: 'fertig', unterlage: r.dokument, doppelt: r.doppelt,
            ...(r.doppelt ? {} : { ansage: { status: 'laeuft', url: `/api/unterlagen/${encodeURIComponent(r.dokument.docId)}/ansage` } }) });
        }
        // Frisch laden und anhängen (falls parallel ein anderes Dokument dazukam).
        speichereKontext(sess.username, [...ladeKontext(sess.username), dok]);
        console.log(`Kontext: Dokument hinzugefügt (${typ}, ${Math.round(groesse / 1024)} KB → ${text.length} Zeichen).`);
        return sendJson(res, 201, { ...kontextSicht(dok), status: 'fertig' });
      });
      return sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
    } catch (e) {
      if (e.status === 413) res.setHeader('Connection', 'close');   // Rest einer zu großen Anfrage nicht mehr lesen
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      if (e.status) throw e;
      console.log('Kontext: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Deine Unterlagen lassen sich gerade nicht laden. Bitte versuch es gleich noch einmal.' });
    }
  }

  // VORÜBERGEHEND: technische Verbindungs-Diagnose (nur Zustandsnamen, keine Inhalte).
  if (route === 'POST /api/diagnose') {
    const b = await readJson(req);
    const t = typeof b.e === 'string' && /^[a-zA-Z0-9 :\/._=,|-]{1,160}$/.test(b.e) ? b.e : 'ungueltig';
    console.log(`Diagnose ${new Date().toISOString().slice(11, 19)}: ${t}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname.startsWith('/api/avatar/')) {
    try {
      return await avatarRoute(route, req, res, sessions.get(sess.token));
    } catch (e) {
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      console.log('Avatar: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Interner Fehler beim Avatar.' });
    }
  }

  if (route === 'POST /api/uebersetzen') {
    const b = (await readJson(req, MAX_BODY_UEBERSETZEN)) || {};
    if (b.modus === 'zielsprache') return sendJson(res, 400, { fehler: 'Die Zielsprache ist noch nicht festgelegt. Bitte „Einfache Sprache“ wählen.' });
    if (!MODI.includes(b.modus)) return sendJson(res, 400, { fehler: 'Unbekannter Modus.' });
    if (typeof b.text !== 'string' || !b.text.trim()) return sendJson(res, 400, { fehler: 'Bitte zuerst einen Text einfügen.' });
    if (b.text.length > MAX_TEXT) return sendJson(res, 400, { fehler: `Der Text ist zu lang (höchstens ${MAX_TEXT.toLocaleString('de-DE')} Zeichen).` });
    try {
      const systemPrompt = ladeSystemPrompt();
      const ergebnis = await frageKi(systemPrompt, b.modus, b.text);
      return sendJson(res, 200, { ...ergebnis, anbieter: ANBIETER });
    } catch (e) {
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      console.log('KI-Anfrage: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Das Übersetzen hat gerade nicht geklappt. Bitte versuch es gleich noch einmal.' });
    }
  }

  // Dashboard (Termine + Medikamentenplan, dashboard.js vom Dashboard-Agenten). Patient immer aus der Anmeldung.
  if (dashboard && (url.pathname === '/api/dashboard' || url.pathname === '/api/termine' || url.pathname.startsWith('/api/termine/'))) {
    try {
      if (await dashboard.route(req, res, url, { pid: patientVon(sess.username), username: sess.username, sendJson, readJson })) return;
      return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
    } catch (e) {
      if (e && e.meldung) return sendJson(res, e.status || 500, { fehler: e.meldung });
      console.log('Dashboard: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Deine Termine lassen sich gerade nicht laden. Bitte versuch es gleich noch einmal.' });
    }
  }
  // Unterlagen, Zeitstrahl, Gesundheitsangaben, Onboarding (patientendaten.js). Immer nur der eigene Test-Patient
  // (aus der Anmeldung, nie aus der URL). Inhalte werden nie geloggt.
  if (url.pathname === '/api/unterlagen' || url.pathname.startsWith('/api/unterlagen/') || url.pathname.startsWith('/api/zeitstrahl')
      || url.pathname === '/api/onboarding' || url.pathname.startsWith('/api/profil-gesundheit')
      || url.pathname === '/api/gedaechtnis' || url.pathname.startsWith('/api/gedaechtnis/')) {
    try {
      const pid = patientVon(sess.username);
      if (!pid) return sendJson(res, 404, { fehler: 'Kein Test-Patient zugeordnet.' });
      if (route === 'GET /api/unterlagen') return sendJson(res, 200, { patientId: pid, unterlagen: pd.liste(pid) });
      if (route === 'POST /api/unterlagen') {
        const r = await mitUploadPlatz(async () => legeUnterlageAn(pid, (await readJson(req, MAX_BODY_UNTERLAGEN)) || {}, profilSprache(sess.username)));
        return sendJson(res, 201, { unterlage: r.dokument, doppelt: r.doppelt, zeitstrahl: r.doppelt ? 'fertig' : 'laeuft',
          ...(r.doppelt ? {} : { ansage: { status: 'laeuft', url: `/api/unterlagen/${encodeURIComponent(r.dokument.docId)}/ansage` } }) });
      }
      // Sofort-Lesen: kurze Ansage zur neuen Unterlage (Browser fragt nach und lässt mitano. sie sprechen).
      const mAnsage = url.pathname.match(/^\/api\/unterlagen\/([^/]+)\/ansage$/);
      if (mAnsage && req.method === 'GET') {
        const docId = dekodiere(mAnsage[1]);
        const a = ANSAGEN.get(`${pid}:${docId}`);
        if (!a) return sendJson(res, 404, { fehler: 'Zu dieser Unterlage gibt es keine Ansage.' });
        if (a.status === 'fertig') {
          // „Ja“ als nächste Antwort → mitano. erklärt genau dieses Dokument.
          const roh = sessions.get(sess.token);
          let titel = '';
          try { titel = rag.ladeDokument(pid, docId).titel || ''; } catch {}
          if (roh) { roh.ansageFokus = { docId, titel, seit: Date.now() }; roh.offenerRest = null; }
        }
        return sendJson(res, 200, { status: a.status, text: a.text, sprache: a.sprache });
      }
      const mBild = url.pathname.match(/^\/api\/unterlagen\/([^/]+)\/bild\/(\d{1,3})$/);
      if (mBild && req.method === 'GET') {
        const b = pd.bild(pid, dekodiere(mBild[1]), Number(mBild[2]));
        res.writeHead(200, { 'Content-Type': b.mime, 'Cache-Control': 'private, no-store', 'Content-Length': b.daten.length });
        return res.end(b.daten);
      }
      const mDoc = url.pathname.match(/^\/api\/unterlagen\/([^/]+)$/);
      if (mDoc) {
        const docId = dekodiere(mDoc[1]);
        if (req.method === 'GET') return sendJson(res, 200, { unterlage: pd.dokument(pid, docId) });
        if (req.method === 'PATCH') {
          const b = (await readJson(req)) || {};
          const u = pd.umbenennen(pid, docId, { titel: b.titel, datum: b.datum });
          console.log('Unterlagen: Titel/Datum geändert.');
          return sendJson(res, 200, { unterlage: u });
        }
        if (req.method === 'DELETE') {
          pd.loeschen(pid, docId);
          dokumentEntfernt(pid, docId);
          console.log('Unterlagen: ein Dokument gelöscht.');
          return sendJson(res, 200, { geloescht: docId, unterlagen: pd.liste(pid) });
        }
        return sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
      }
      if (route === 'GET /api/zeitstrahl') return sendJson(res, 200, pd.zeitstrahl(pid));
      if (route === 'POST /api/zeitstrahl/aktualisieren') {
        await readJson(req);
        const r = await pd.aktualisiereZeitstrahl(pid, { parallel: 3 });
        console.log(`Zeitstrahl: ${r.berechnet} berechnet, ${r.fehler.length} Fehler.`);
        return sendJson(res, 200, { berechnet: r.berechnet, fehler: r.fehler, zeitstrahl: pd.zeitstrahl(pid) });
      }
      if (route === 'GET /api/onboarding') {
        const spr = profilSprache(sess.username);
        return sendJson(res, 200, { ...pd.onboarding(pid, spr), patientId: pid, wakewordHinweis: WAKEWORD_HINWEIS[spr] || WAKEWORD_HINWEIS.de });
      }
      if (route === 'GET /api/profil-gesundheit') return sendJson(res, 200, pd.profil(pid));
      // Gedächtnis „Was mitano. über dich weiß“ (werkzeuge/GEDAECHTNIS_UI.md)
      if (route === 'GET /api/gedaechtnis') return sendJson(res, 200, gd.exportiere(pid));
      if (route === 'DELETE /api/gedaechtnis') { console.log('Gedächtnis: alles vergessen.'); return sendJson(res, 200, gd.vergiss(pid)); }
      const mFakt = url.pathname.match(/^\/api\/gedaechtnis\/([a-z0-9-]{4,40})$/i);
      if (mFakt && req.method === 'DELETE') { const g = gd.loescheFakt(pid, mFakt[1]); console.log('Gedächtnis: ein Eintrag vergessen.'); return sendJson(res, 200, g); }
      if (route === 'PUT /api/profil-gesundheit') {
        const b = (await readJson(req)) || {};
        if (Array.isArray(b.werte)) return sendJson(res, 200, pd.setzeProfilFeld(pid, b.feld, b.werte));
        return sendJson(res, 200, pd.speicherProfilAngabe(pid, { feld: b.feld, wert: b.wert, quelle: b.quelle }));
      }
      const mFeld = url.pathname.match(/^\/api\/profil-gesundheit\/([a-z]+)\/([a-z0-9_-]+)$/i);
      if (mFeld && req.method === 'DELETE') return sendJson(res, 200, pd.loescheProfilAngabe(pid, mFeld[1], mFeld[2]));
      return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
    } catch (e) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      if (e.status) throw e;
      console.log('Unterlagen: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Deine Unterlagen lassen sich gerade nicht laden. Bitte versuch es gleich noch einmal.' });
    }
  }

  // Wissensspeicher: Test-Patient des angemeldeten Nutzers (nur synthetische Daten). Inhalte werden nie geloggt.
  if (url.pathname === '/api/patient' || url.pathname.startsWith('/api/patient/')) {
    try {
      const patientId = patientVon(sess.username);
      if (route === 'GET /api/patient') {
        return sendJson(res, 200, { patient: patientId ? patientSicht(rag.ladePatient(patientId)) : null });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/patient/dokument/')) {
        if (!patientId) return sendJson(res, 404, { fehler: 'Dir ist kein Test-Patient zugeordnet.' });
        const docId = dekodiere(url.pathname.slice('/api/patient/dokument/'.length));
        const d = rag.ladeDokument(patientId, docId);
        return sendJson(res, 200, { docId: d.docId, titel: d.titel, datum: d.datum, typ: d.typ, quelle: d.quelle, text: d.text });
      }
      return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
    } catch (e) {
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      console.log('Patient: unerwarteter Fehler.');
      return sendJson(res, 500, { fehler: 'Interner Fehler beim Wissensspeicher.' });
    }
  }

  // Admin: Test-Patienten verwalten, Beispielbriefe importieren, Nutzer zuordnen.
  if (url.pathname.startsWith('/api/admin/')) {
    if (sess.role !== 'admin') return sendJson(res, 403, { fehler: 'Nur für Administratoren.' });
    try {
      const adminSicht = () => ({
        patienten: rag.listePatienten(),
        nutzer: users.map((u) => ({ username: u.username, role: u.role, patientId: patientVon(u.username) })),
        standardPatient: STANDARD_PATIENT,
      });
      if (route === 'GET /api/admin/patienten') return sendJson(res, 200, adminSicht());
      // Pitch-Demo zurücksetzen: Unterlagen/Zeitstrahl/Profil von p-demo leeren, Sitzungs-Unterlagen und Einrichtung von DEMO_USER.
      if (route === 'POST /api/admin/demo-zuruecksetzen') {
        await readJson(req);
        gd.vergiss(pd.PATIENT_DEMO);   // verwirft auch noch laufende Lernvorgänge
        for (const k of [...ANSAGEN.keys()]) if (k.startsWith(pd.PATIENT_DEMO + ':')) ANSAGEN.delete(k);
        if (dashboard && typeof dashboard.vergissPatient === 'function') { try { await dashboard.vergissPatient(pd.PATIENT_DEMO); } catch {} }
        const r = pd.zuruecksetzen(pd.PATIENT_DEMO);
        const demo = String(process.env.DEMO_USER || '').toLowerCase().trim();
        if (validName(demo)) {
          try { speichereKontext(demo, []); } catch {}
          profile.set(demo, { ...(profile.get(demo) || {}), eingerichtet: false });
          speichereProfile();
          for (const s of sessions.values()) if (s.username === demo) { s.protokoll = []; s.letzteQuellenDocs = []; s.ansageFokus = null; s.offenerRest = null; verwirfSpekulation(s); }
        }
        console.log('Demo: zurückgesetzt.');
        return sendJson(res, 200, r);
      }
      if (route === 'GET /api/admin/beispielbriefe') return sendJson(res, 200, { dateien: rag.listeBeispielbriefe() });
      if (route === 'POST /api/admin/patienten') {
        const b = (await readJson(req)) || {};
        const id = String(b.id || '').trim().toLowerCase();
        const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
        if (!name) return sendJson(res, 400, { fehler: 'Bitte einen (erfundenen) Namen angeben.' });
        const geburtsjahr = b.geburtsjahr === undefined || b.geburtsjahr === null || b.geburtsjahr === '' ? null : Number(b.geburtsjahr);
        if (geburtsjahr !== null && !(Number.isInteger(geburtsjahr) && geburtsjahr >= 1900 && geburtsjahr <= 2100)) return sendJson(res, 400, { fehler: 'Ungültiges Geburtsjahr.' });
        rag.legePatientAn({ patientId: id, name, geburtsjahr });
        console.log('Wissensspeicher: Test-Patient angelegt/geändert.');
        return sendJson(res, 201, { ...adminSicht(), patient: patientSicht(rag.ladePatient(id)) });
      }
      const mImport = url.pathname.match(/^\/api\/admin\/patienten\/([^/]+)\/import$/);
      if (req.method === 'POST' && mImport) {
        const id = dekodiere(mImport[1]);
        const b = (await readJson(req)) || {};
        const p = rag.ladePatient(id);   // 404, wenn es ihn nicht gibt
        const namen = Array.isArray(b.dateien) ? b.dateien.filter((x) => typeof x === 'string').slice(0, 62) : null;
        const dateien = rag.waehleBeispielbriefe({ anzahl: b.anzahl, namen });
        if (!dateien.length) return sendJson(res, 400, { fehler: 'Keine passenden Beispielbriefe gefunden.' });
        const r = rag.importiereAusOrdner({ patientId: id, name: p.name, dateien });
        console.log(`Wissensspeicher: Import ${r.neu} neu, ${r.doppelt} doppelt, ${r.fehler} Fehler, ${r.chunks} Abschnitte.`);
        return sendJson(res, 200, { neu: r.neu, doppelt: r.doppelt, fehler: r.fehler, abschnitte: r.chunks, patient: patientSicht(r.patient) });
      }
      const mPatient = url.pathname.match(/^\/api\/admin\/patienten\/([^/]+)$/);
      if (mPatient && req.method === 'GET') return sendJson(res, 200, { patient: patientSicht(rag.ladePatient(dekodiere(mPatient[1]))) });
      if (mPatient && req.method === 'DELETE') {
        const id = dekodiere(mPatient[1]);
        rag.ladePatient(id);
        rag.loeschePatient(id);
        for (const [n, pid] of Object.entries(zuordnung)) if (pid === id) delete zuordnung[n];
        schreibeJsonAtomar(ZUORDNUNG_FILE, zuordnung);
        console.log('Wissensspeicher: Test-Patient gelöscht.');
        return sendJson(res, 200, adminSicht());
      }
      if (route === 'PUT /api/admin/zuordnung') {
        const b = (await readJson(req)) || {};
        const username = String(b.username || '').toLowerCase().trim();
        if (!users.some((u) => u.username === username)) return sendJson(res, 404, { fehler: 'Nutzer nicht gefunden.' });
        if (b.patientId === null || b.patientId === '') setzeZuordnung(username, null);
        else {
          const pid = String(b.patientId);
          if (!patientExistiert(pid)) return sendJson(res, 404, { fehler: 'Diesen Test-Patienten gibt es nicht.' });
          setzeZuordnung(username, pid);
        }
        return sendJson(res, 200, adminSicht());
      }
      return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
    } catch (e) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      if (e.status) throw e;
      console.log('Admin/Wissensspeicher: unerwarteter Fehler.');
      return sendJson(res, 500, { fehler: 'Interner Fehler beim Wissensspeicher.' });
    }
  }

  // Ab hier nur Administratoren
  if (url.pathname.startsWith('/api/nutzer')) {
    if (sess.role !== 'admin') return sendJson(res, 403, { fehler: 'Nur für Administratoren.' });

    if (route === 'GET /api/nutzer') {
      return sendJson(res, 200, users.map((u) => ({ username: u.username, role: u.role })));
    }
    if (route === 'POST /api/nutzer') {
      const b = await readJson(req);
      const username = String(b.username || '').toLowerCase().trim();
      if (!validName(username)) return sendJson(res, 400, { fehler: 'Name: 3 bis 32 Zeichen (a–z, 0–9, Punkt, Strich).' });
      if (!validRole(b.role)) return sendJson(res, 400, { fehler: 'Unbekannte Rolle.' });
      if (typeof b.password !== 'string' || b.password.length < MIN_PW || b.password.length > 200) {
        return sendJson(res, 400, { fehler: `Passwort: mindestens ${MIN_PW} Zeichen.` });
      }
      if (users.some((u) => u.username === username)) return sendJson(res, 409, { fehler: 'Name ist schon vergeben.' });
      users.push({ username, role: b.role, ...(await hashPassword(b.password)) });
      saveUsers();
      return sendJson(res, 201, { username, role: b.role });
    }
    if (req.method === 'DELETE') {
      const name = dekodiere(url.pathname.slice('/api/nutzer/'.length));
      const target = users.find((u) => u.username === name);
      if (!target) return sendJson(res, 404, { fehler: 'Nutzer nicht gefunden.' });
      if (name === sess.username) return sendJson(res, 400, { fehler: 'Das eigene Konto kann nicht gelöscht werden.' });
      users = users.filter((u) => u.username !== name);
      saveUsers();
      try { speichereKontext(name, []); } catch {}
      entferneProfil(name);
      if (Object.hasOwn(zuordnung, name)) setzeZuordnung(name, undefined);
      for (const [t, s] of sessions) if (s.username === name) beendeSitzung(t);
      speichereSitzungen();
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
}

// ---------- Statische Dateien ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
// Videos/Audio: Safari (iPhone) verlangt Range-Anfragen (206 Partial Content), sonst spielt <video> nicht ab.
const RANGE_TYPEN = new Set(['.mp4', '.webm', '.m4a']);
// Video/Audio aus public/ mit Range-Unterstützung (206) und Zwischenspeicher-Erlaubnis.
function sendeMedium(req, res, file, rel) {
  fs.stat(file, (err, st) => {
    if (res.destroyed) return;
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    const kopf = { 'Content-Type': TYPES[path.extname(file).toLowerCase()], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (req.headers.range && !range) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    let start = 0, ende = st.size - 1, status = 200;
    if (range) {
      if (range[1] === '' && range[2] !== '') { start = Math.max(0, st.size - Number(range[2])); }
      else { start = Number(range[1] || 0); if (range[2] !== '') ende = Math.min(Number(range[2]), st.size - 1); }
      if (start > ende || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206; kopf['Content-Range'] = `bytes ${start}-${ende}/${st.size}`;
    }
    kopf['Content-Length'] = ende - start + 1;
    res.writeHead(status, kopf);
    if (req.method === 'HEAD') return res.end();
    const strom = fs.createReadStream(file, { start, end: ende });
    strom.on('error', () => res.destroy());
    res.on('close', () => strom.destroy());
    strom.pipe(res);
  });
}
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }   // kein Icon, aber kein 404
  const rel = url.pathname === '/' ? 'index.html' : dekodiere(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  if (RANGE_TYPEN.has(path.extname(file).toLowerCase())) return sendeMedium(req, res, file, rel);
  fs.readFile(file, (err, data) => {
    if (res.destroyed) return;
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html')) data = Buffer.from(data.toString('utf8').replaceAll('__NONCE__', res.nonce));
    // Fremdbibliotheken in fester Version (public/vendor/) dürfen zwischengespeichert werden.
    if (rel.startsWith('vendor/')) res.setHeader('Cache-Control', 'public, max-age=86400');
    res.writeHead(200, { 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Start ----------
const server = http.createServer(async (req, res) => {
  res.nonce = crypto.randomBytes(16).toString('base64');
  securityHeaders(res, res.nonce);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    // Bewusst keine Inhalte der Anfrage loggen – nur die Fehlerart.
    const status = e?.status || (e instanceof URIError ? 400 : 500);
    if (status === 500) console.log(`Unerwarteter Fehler (${fehlerArt(e)}).`);
    if (status === 413 && !res.headersSent) res.setHeader('Connection', 'close');   // Rest der zu großen Anfrage nicht mehr lesen
    sendJson(res, status, { fehler: e?.meldung || (status === 500 ? 'Interner Fehler. Bitte erneut versuchen.' : 'Ungültige Anfrage.') });
  }
});

ladeAppAnweisung();
ladeProfile();
ladeZuordnung();
try {
  const r = pd.richteTestpatientenEin();
  console.log(`Test-Patienten: p2 ${r.p2}, p-demo ${r['p-demo']}.`);
} catch (e) { console.log(`Test-Patienten konnten nicht eingerichtet werden (${e.status || 'Fehler'}).`); }
standardPatientAnlegen();
// Gedächtnis aus den Unterlagen von p2 (nur fehlende/geänderte Briefe; sonst kein KI-Aufruf dank Prüfsumme).
if (process.env.ANTHROPIC_API_KEY) {
  gd.lerneAlleDokumente(pd.PATIENT_ADMIN, { parallel: 3 }).then(
    (r) => console.log(`Gedächtnis: ${pd.PATIENT_ADMIN} bereit (${r.gelernt} neu ausgewertet, ${r.ausCache} vorhanden, ${r.fehler.length} Fehler).`),
    (e) => console.log(`Gedächtnis: ${pd.PATIENT_ADMIN} nicht ausgewertet (${e.status || 'Fehler'}).`));
}
// Hinter dem Cloudflare-Tunnel: Verbindungen länger offen halten als der Tunnel (sonst gelegentlich 502).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
server.requestTimeout = 5 * 60 * 1000;   // großer Upload über langsames Netz
server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
server.on('error', (e) => {
  console.log(`Server konnte nicht starten (${fehlerArt(e)}).`);
  if (e && e.code === 'EADDRINUSE') process.exit(1);   // Port belegt: beenden, der Wächter startet später neu
});

// Sauber beenden (SIGTERM/SIGINT, z. B. Neustart): alle offenen D-ID-Sitzungen löschen (Guthaben), Sitzungen speichern.
let wirdBeendet = false;
async function beenden(signal) {
  if (wirdBeendet) return;
  wirdBeendet = true;
  const offen = [...sessions.values()].filter((s) => s.avatar);
  console.log(`Beenden (${signal}): ${offen.length} offene D-ID-Sitzung(en) werden gelöscht.`);
  server.close();
  const zeitlimit = new Promise((ok) => setTimeout(() => ok('zeitlimit'), 8000));
  const erg = await Promise.race([Promise.all(offen.map((s) => stoppeAvatar(s))), zeitlimit]);
  if (erg === 'zeitlimit') console.log('Beenden: D-ID hat nicht rechtzeitig geantwortet.');
  else console.log(`Beenden: ${erg.filter(Boolean).length} von ${offen.length} D-ID-Sitzung(en) gelöscht.`);
  speichereSitzungen();
  process.exit(0);
}
process.on('SIGTERM', () => { beenden('SIGTERM'); });
process.on('SIGINT', () => { beenden('SIGINT'); });

seedAdmin().then(() => {
  ladeSitzungen();
  server.listen(PORT, HOST, () => console.log(`Läuft auf http://${HOST}:${PORT}`));
}, (e) => { console.log(`Start fehlgeschlagen (${fehlerArt(e)}).`); process.exit(1); });
