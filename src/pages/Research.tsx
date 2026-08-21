import { PageHeader } from '../components/UI';
import { ResearchChat } from '../components/ResearchChat';

export function Research() {
  return (
    <>
      <PageHeader title="Research" subtitle="Ask questions locally or in the cloud — your history stays on this machine." />
      <ResearchChat />
    </>
  );
}
