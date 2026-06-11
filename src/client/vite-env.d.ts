/// <reference types="vite/client" />

interface ProductScraperDesktopPickedFile {
  name: string;
  type: string;
  data: ArrayBuffer;
}

interface ProductScraperDesktopApi {
  pickFiles(options: {
    kind: "catalogInput" | "customerDocuments";
    title: string;
    multiple: boolean;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<ProductScraperDesktopPickedFile[]>;
  rememberFileFolder(kind: "catalogInput" | "customerDocuments", file: File): Promise<boolean>;
}

interface Window {
  productScraperDesktop?: ProductScraperDesktopApi;
}
