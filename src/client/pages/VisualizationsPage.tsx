import { useEffect } from 'react';
import VizApp from '@/components/VizApp';

export default function VisualizationsPage() {
    useEffect(() => { document.title = '知识可视化 | Knowledge Visualizations'; }, []);
    return <VizApp />;
}
