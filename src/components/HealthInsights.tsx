import { Lightbulb, TriangleAlert } from 'lucide-react';
import { Card } from './UI';
import type { HealthInsight } from '../lib/healthInsights';

export function HealthInsightList({ insights, title }: { insights: HealthInsight[]; title?: string }) {
  if (!insights.length) return null;
  return (
    <Card className="health-insights-card">
      {title && <div className="card-title"><div><h2>{title}</h2></div></div>}
      <div className="health-insight-list">
        {insights.map(insight => (
          <div className={`health-insight-row ${insight.severity}`} key={insight.id}>
            {insight.severity === 'warn' ? <TriangleAlert size={15} /> : <Lightbulb size={15} />}
            <div>
              <b>{insight.title}</b>
              <small>{insight.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
