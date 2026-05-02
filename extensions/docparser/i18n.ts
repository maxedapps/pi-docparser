import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "es" | "fr" | "pt-BR";
type Key = keyof typeof fallback;
type Params = Record<string, string | number>;

const namespace = "pi-docparser";

const fallback = {
  "tool.label": "Document Parse",
  "tool.description": "Parse local documents with bundled LiteParse support. Supports PDF, DOCX, PPTX, XLSX, CSV, and common images. Returns parsed output saved to temp files plus metadata and optional PDF screenshots.",
  "tool.promptSnippet": "Parse local documents to text or JSON with OCR, bounding boxes, page ranges, and optional PDF screenshots. Full results are saved to temp files for follow-up inspection with read.",
  "tool.guideline.useTool": "Use this tool instead of composing LiteParse CLI commands manually when the user wants local document parsing.",
  "tool.guideline.readOutput": "After this tool returns output or screenshot paths, use read on those files when you need the full parsed content or to inspect generated screenshots.",
  "progress.cancelled": "Document parsing was cancelled before it started.",
  "progress.checkDeps": "Checking host dependencies...",
  "progress.loading": "Loading LiteParse...",
  "progress.parsing": "Parsing document: {path}",
  "progress.saved": "Saved parsed output to {path}",
} as const;

const translations: Record<Locale, Partial<Record<Key, string>>> = {
  es: {
    "tool.label": "Analizar documento",
    "tool.description": "Analiza documentos locales con soporte LiteParse incluido. Admite PDF, DOCX, PPTX, XLSX, CSV e imágenes comunes. Devuelve la salida analizada guardada en archivos temporales, metadatos y capturas PDF opcionales.",
    "tool.promptSnippet": "Analiza documentos locales a texto o JSON con OCR, cuadros delimitadores, rangos de páginas y capturas PDF opcionales. Los resultados completos se guardan en archivos temporales para inspección posterior con read.",
    "tool.guideline.useTool": "Usa esta herramienta en lugar de componer comandos LiteParse CLI manualmente cuando el usuario quiera analizar documentos locales.",
    "tool.guideline.readOutput": "Después de que esta herramienta devuelva rutas de salida o capturas, usa read en esos archivos cuando necesites el contenido completo o inspeccionar las capturas generadas.",
    "progress.cancelled": "El análisis del documento se canceló antes de comenzar.",
    "progress.checkDeps": "Comprobando dependencias del sistema...",
    "progress.loading": "Cargando LiteParse...",
    "progress.parsing": "Analizando documento: {path}",
    "progress.saved": "Salida analizada guardada en {path}",
  },
  fr: {
    "tool.label": "Analyser un document",
    "tool.description": "Analyse des documents locaux avec la prise en charge LiteParse intégrée. Prend en charge PDF, DOCX, PPTX, XLSX, CSV et les images courantes. Retourne la sortie analysée enregistrée dans des fichiers temporaires, des métadonnées et des captures PDF facultatives.",
    "tool.promptSnippet": "Analyse des documents locaux en texte ou JSON avec OCR, boîtes englobantes, plages de pages et captures PDF facultatives. Les résultats complets sont enregistrés dans des fichiers temporaires pour inspection ultérieure avec read.",
    "tool.guideline.useTool": "Utilisez cet outil au lieu de composer manuellement des commandes LiteParse CLI quand l’utilisateur veut analyser des documents locaux.",
    "tool.guideline.readOutput": "Après le retour de chemins de sortie ou de captures par cet outil, utilisez read sur ces fichiers lorsque vous avez besoin du contenu complet ou d’inspecter les captures générées.",
    "progress.cancelled": "L’analyse du document a été annulée avant de commencer.",
    "progress.checkDeps": "Vérification des dépendances hôte...",
    "progress.loading": "Chargement de LiteParse...",
    "progress.parsing": "Analyse du document : {path}",
    "progress.saved": "Sortie analysée enregistrée dans {path}",
  },
  "pt-BR": {
    "tool.label": "Analisar documento",
    "tool.description": "Analisa documentos locais com suporte LiteParse incluído. Compatível com PDF, DOCX, PPTX, XLSX, CSV e imagens comuns. Retorna a saída analisada salva em arquivos temporários, metadados e capturas PDF opcionais.",
    "tool.promptSnippet": "Analisa documentos locais para texto ou JSON com OCR, caixas delimitadoras, intervalos de páginas e capturas PDF opcionais. Os resultados completos são salvos em arquivos temporários para inspeção posterior com read.",
    "tool.guideline.useTool": "Use esta ferramenta em vez de montar comandos LiteParse CLI manualmente quando o usuário quiser analisar documentos locais.",
    "tool.guideline.readOutput": "Depois que esta ferramenta retornar caminhos de saída ou capturas, use read nesses arquivos quando precisar do conteúdo completo ou inspecionar as capturas geradas.",
    "progress.cancelled": "A análise do documento foi cancelada antes de começar.",
    "progress.checkDeps": "Verificando dependências do host...",
    "progress.loading": "Carregando LiteParse...",
    "progress.parsing": "Analisando documento: {path}",
    "progress.saved": "Saída analisada salva em {path}",
  },
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

export function t(key: Key, params?: Params): string {
  const locale = currentLocale as Locale | undefined;
  const template = locale ? translations[locale]?.[key] : undefined;
  return format(template ?? fallback[key], params);
}

export function initI18n(pi: ExtensionAPI): void {
  pi.events?.emit?.("pi-core/i18n/registerBundle", { namespace, defaultLocale: "en", fallback, translations });
  pi.events?.on?.("pi-core/i18n/localeChanged", (event: unknown) => {
    currentLocale = event && typeof event === "object" && "locale" in event ? String((event as { locale?: unknown }).locale ?? "") : undefined;
  });
  pi.events?.emit?.("pi-core/i18n/requestApi", {
    namespace,
    onApi(api: { getLocale?: () => string | undefined }) {
      currentLocale = api.getLocale?.();
    },
  });
}
