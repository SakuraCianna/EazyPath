import type { ServiceAction } from '../db/schema.js';

export type LinkPlatform = 'amap' | 'didi' | 'ctrip' | 'meituan' | 'railway12306';

export interface LinkTarget {
  destinationName: string;
  longitude?: number | undefined;
  latitude?: number | undefined;
  date?: string | undefined;
  accessibilityNotes?: string | undefined;
}

export function resolvePublicActions(platform: LinkPlatform, target: LinkTarget): ServiceAction[] {
  const notes = target.accessibilityNotes ?? '需要轮椅无台阶通行，请人工确认入口、门宽和电梯状态';
  switch (platform) {
    case 'amap': {
      if (target.longitude === undefined || target.latitude === undefined) {
        return [clipboardAction(`目的地: ${target.destinationName}\n${notes}`)];
      }
      const params = new URLSearchParams({
        sourceApplication: 'EazyPath',
        dlat: String(target.latitude),
        dlon: String(target.longitude),
        dname: target.destinationName,
        dev: '0',
        t: '2',
      });
      const web = new URL('https://uri.amap.com/navigation');
      web.searchParams.set('to', `${target.longitude},${target.latitude},${target.destinationName}`);
      web.searchParams.set('mode', 'walk');
      web.searchParams.set('src', 'EazyPath');
      web.searchParams.set('callnative', '1');
      return [
        { type: 'app_uri', label: '在高德查看普通步行路线', platform, url: `amapuri://route/plan/?${params}` },
        { type: 'web', label: '高德网页版', platform, url: web.toString() },
        clipboardAction(`目的地: ${target.destinationName}\n注意: 高德未提供轮椅路线模式，请结合 EazyPath 路段证据复核。\n${notes}`),
      ];
    }
    case 'railway12306':
      return [
        {
          type: 'web',
          label: '打开 12306 重点旅客服务说明',
          platform,
          url: 'https://kyfw.12306.cn/otn/view/icentre_qxyyInfo.html',
        },
        clipboardAction(`12306 重点旅客服务需求\n目的地: ${target.destinationName}\n日期: ${target.date ?? '待补充'}\n${notes}\n线上申请通常需在乘车前至少 6 小时提交，请以 12306 当前规则为准。`),
      ];
    case 'ctrip':
      return [
        { type: 'web', label: '打开携程酒店首页', platform, url: 'https://m.ctrip.com/webapp/hotels/' },
        clipboardAction(`酒店搜索: ${target.destinationName}\n无障碍询房要求: ${notes}`),
      ];
    case 'meituan':
      return [
        { type: 'web', label: '打开美团移动网页', platform, url: 'https://i.meituan.com/' },
        clipboardAction(`地点搜索: ${target.destinationName}\n无障碍就餐要求: ${notes}`),
      ];
    case 'didi':
      return [
        clipboardAction(`打车目的地: ${target.destinationName}\n乘客携带轮椅，请司机确认后备箱空间并在安全位置上下车。\n${notes}`),
      ];
  }
}

function clipboardAction(content: string): ServiceAction {
  return { type: 'clipboard', label: '复制无障碍沟通卡', content };
}
