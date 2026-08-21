// A page-keyed registry the center FAB reads to decide what it does. Module-level rather than
// Context: the FAB and the page that owns the current action are siblings under App, not
// ancestor/descendant, so passing this through props would mean threading it across every page.
// `notify` plus `useSyncExternalStore` in MobileNav keeps the FAB's rendered icon/label in sync
// even though registration happens in a *different* component's effect, on a *later* commit
// than the one where MobileNav itself re-rendered for the navigation.
export interface FabAction {
  label: string;
  onTrigger: () => void;
}

type Listener = () => void;

const registry = new Map<string, FabAction>();
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export function registerFabAction(page: string, action: FabAction): () => void {
  registry.set(page, action);
  notify();
  return () => {
    if (registry.get(page) === action) {
      registry.delete(page);
      notify();
    }
  };
}

export function subscribeFabActions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFabAction(page: string): FabAction | undefined {
  return registry.get(page);
}
