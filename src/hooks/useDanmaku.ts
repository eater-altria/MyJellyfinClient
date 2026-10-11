import { useCallback, useEffect, useRef, useState } from 'react';
import type { BaseItem } from '../api/mediaServer';
import { danmakuKeyword, loadDanmakuChoice, loadServerDanmaku, matchDanmaku, searchDanmaku, type DanmakuChoice } from '../api/danmaku';
import { DANMAKU_MAX_BYTES, parseDanmaku, type DanmakuComment } from '../player/danmaku';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';

const EMPTY_COMMENTS: DanmakuComment[] = [];
const EMPTY_CHOICES: DanmakuChoice[] = [];

export function useDanmaku(serverId: string | undefined, item: BaseItem | null, active: boolean) {
  const enabled = useSettings(s => s.danmakuEnabled);
  const source = useSettings(s => s.danmakuSource);
  const apiUrl = useSettings(s => s.danmakuApiUrl);
  const [comments, setComments] = useState<DanmakuComment[]>([]);
  const [choices, setChoices] = useState<DanmakuChoice[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState({ scope: '', id: '' });
  const [matched, setMatched] = useState({ scope: '', id: '' });
  const [manualSearchScope, setManualSearchScope] = useState('');
  const [local, setLocal] = useState<{ scope: string; comments: DanmakuComment[] } | null>(null);
  const generation = useRef(0);
  const scope = JSON.stringify([serverId, item?.Id]);
  const sourceScope = JSON.stringify([scope, source, apiUrl]);
  const selection = selected.scope === sourceScope ? selected.id : '';
  const matching = manualSearchScope !== sourceScope;
  const [publishedScope, setPublishedScope] = useState('');
  const currentScope = useRef(scope);
  const importGeneration = useRef(0);
  currentScope.current = scope;

  useEffect(() => {
    setLocal(null); setSelected({ scope: '', id: '' }); setMatched({ scope: '', id: '' }); setManualSearchScope('');
    setChoices([]); setComments([]); setStatus('');
    importGeneration.current++;
  }, [scope]);
  useEffect(() => () => { importGeneration.current++; }, [active]);

  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    setComments([]); setLoading(false);
    if (!active || !item || !serverId || !enabled) return () => controller.abort();
    const publish = (values: DanmakuComment[], automaticallyMatched = false) => {
      if (controller.signal.aborted || generation.current !== id) return;
      setPublishedScope(sourceScope);
      setComments(values); setLoading(false);
      setStatus(values.length ? `${automaticallyMatched ? '自动匹配成功，' : ''}已加载 ${values.length} 条弹幕` : '此弹幕文件没有可播放的弹幕');
    };
    if (local?.scope === scope) { publish(local.comments); return () => controller.abort(); }
    const timer = window.setTimeout(() => controller.abort('timeout'), 20000);
    setLoading(true); setStatus('正在加载弹幕…');
    (async () => {
      try {
        if (source === 'server') {
          const api = useServers.getState().getApi(serverId);
          if (!api) throw new Error('未找到服务器');
          publish(await loadServerDanmaku(api, item.Id, controller.signal));
        } else if (selection) {
          publish(await loadDanmakuChoice(apiUrl, selection, controller.signal));
        } else {
          if (matching) {
            setStatus('正在自动匹配弹幕…');
            const result = await matchDanmaku(apiUrl, item, controller.signal);
            if (controller.signal.aborted || generation.current !== id) return;
            if (result) {
              setPublishedScope(sourceScope); setChoices([result]); setMatched({ scope: sourceScope, id: result.id });
              publish(await loadDanmakuChoice(apiUrl, result.id, controller.signal), true);
              return;
            }
          }
          const results = await searchDanmaku(apiUrl, danmakuKeyword(item), controller.signal);
          if (controller.signal.aborted || generation.current !== id) return;
          setPublishedScope(sourceScope); setChoices(results); setLoading(false);
          setMatched({ scope: '', id: '' });
          setStatus(results.length ? matching ? '未能自动匹配，请选择弹幕来源与集数' : '请选择弹幕来源与集数'
            : '没有搜索到弹幕，可导入 XML 文件');
        }
      } catch (error) {
        if (generation.current !== id || (controller.signal.aborted && controller.signal.reason !== 'timeout')) return;
        setLoading(false);
        setStatus(controller.signal.reason === 'timeout' ? '弹幕请求超时，请重试'
          : error instanceof TypeError ? '弹幕连接失败，请检查地址与服务端跨域权限'
            : error instanceof Error ? error.message : '弹幕加载失败，请重试');
      } finally { window.clearTimeout(timer); }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [serverId, item, active, enabled, source, apiUrl, revision, selection, local, scope, sourceScope, matching]);

  const importXml = useCallback(async (file: File) => {
    const importingScope = currentScope.current, id = ++importGeneration.current;
    try {
      if (file.size > DANMAKU_MAX_BYTES) throw new Error('弹幕文件超过 16 MB');
      const data = parseDanmaku(await file.text());
      if (currentScope.current !== importingScope || importGeneration.current !== id || !active) return;
      setLocal({ scope: importingScope, comments: data }); useSettings.getState().set('danmakuEnabled', true);
    } catch (e) {
      if (currentScope.current === importingScope && importGeneration.current === id && active) {
        setStatus(e instanceof Error ? e.message : '弹幕文件读取失败');
      }
    }
  }, [active]);
  const retry = useCallback(() => {
    setLocal(null); setSelected({ scope: '', id: '' }); setMatched({ scope: '', id: '' }); setManualSearchScope('');
    setChoices([]); setRevision(r => r + 1);
  }, []);
  const select = useCallback((id: string) => { setLocal(null); setSelected({ scope: sourceScope, id }); }, [sourceScope]);
  const search = useCallback(() => {
    setLocal(null); setSelected({ scope: '', id: '' }); setMatched({ scope: '', id: '' });
    setChoices([]); setManualSearchScope(sourceScope); setRevision(r => r + 1);
  }, [sourceScope]);
  return { comments: active && enabled && publishedScope === sourceScope ? comments : EMPTY_COMMENTS,
    choices: publishedScope === sourceScope ? choices : EMPTY_CHOICES, status, loading,
    selection: selection || (matched.scope === sourceScope ? matched.id : ''), importXml, retry, select, search };
}
