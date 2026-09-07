export class AuthEventNotifier {
  private listeners: Array<() => void> = [];

  onUnauthorized(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  emitUnauthorized(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in unauthorized listener:', err);
      }
    }
  }
}

export const authNotifier = new AuthEventNotifier();
