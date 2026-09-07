export type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>
