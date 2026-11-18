interface NextermHttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  bearer?: string;
}
interface NextermSshRequest {
  host: string;
  port: number;
  username: string;
  label: string;
  passwordKey?: string;
}
interface NextermSdk {
  readonly ready: Promise<void>;
  request<T = unknown>(name: string, value?: unknown): Promise<T>;
  handle(name: string, handler: (value: any) => unknown | Promise<unknown>): () => void;
  onCommand(id: string, handler: (value: any) => unknown | Promise<unknown>): () => void;
  on(name: string, listener: (value: any) => void): () => void;
  publish(name: string, value: unknown): Promise<void>;
  http<T = unknown>(request: NextermHttpRequest): Promise<T>;
  readonly network: {request(origin: string): Promise<boolean>; isGranted(origin: string): Promise<boolean>};
  readonly config: {get<T = Record<string, unknown>>(): Promise<T>; set(value: Record<string, unknown>): Promise<void>};
  readonly secrets: {set(key: string, value: string, origin: string): Promise<void>; delete(key: string, origin: string): Promise<void>};
  readonly credentials: {get(key: string, origin: string): Promise<string | null>; set(key: string, value: string, origin: string): Promise<void>; delete(key: string, origin: string): Promise<void>};
  readonly status: {update(id: string, text: string, tooltip?: string): Promise<void>};
  readonly views: {open(id: string): Promise<void>};
  readonly sessions: {
    openSsh(request: NextermSshRequest): Promise<{paneId: string}>;
    updateSource(id: string, catalog: {
      state: "loading" | "ready" | "signedOut" | "error";
      items: {id: string; label: string; description?: string; group?: string}[];
      message?: string;
    }): Promise<void>;
    appendSource(id: string, catalog: {
      state: "loading" | "ready";
      items: {id: string; label: string; description?: string; group?: string}[];
      message?: string;
    }): Promise<void>;
    onConnect(id: string, handler: (request: {itemId: string; choiceId?: string}) =>
      {connection: NextermSshRequest} | {choices: {id: string; label: string}[]} |
      Promise<{connection: NextermSshRequest} | {choices: {id: string; label: string}[]}>): () => void;
  };
}
declare const nexterm: NextermSdk;
