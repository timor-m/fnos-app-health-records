import {expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import Picker from '../src/components/SourceRegionPicker.vue';
import {rotateRegionBox,unrotateRegionPoint,sourceRegion} from '../../shared/source-region';
it('normalizes all four viewing rotations, reverses coordinates and rejects invalid bounds',()=>{
 const box:[number,number,number,number]=[.1,.2,.4,.6];
 for(const angle of [0,90,180,270])expect(rotateRegionBox(rotateRegionBox(box,angle),360-angle)).toEqual(box.map(v=>expect.closeTo(v)));
 expect(unrotateRegionPoint(.8,.1,90)).toEqual([.1,expect.closeTo(.2)]);
 expect(sourceRegion({box:[-.1,0,1,1],rotation:0})).toBeNull();
});
it('requires explicit drawing mode, saves normalized coordinates at zoom and allows clear',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const wrapper=mount(Picker,{props:{src:'/synthetic.png',pageKey:'p',coordinateRotation:0,modelValue:null}});
 try {
  await wrapper.get('img').trigger('load');
  const canvas=wrapper.get('.source-region-canvas');
  canvas.element.getBoundingClientRect=()=>({left:100,top:50,width:400,height:200} as DOMRect);
  (canvas.element as HTMLElement).setPointerCapture=vi.fn();
  expect(canvas.attributes('style')).toContain('pointer-events: none');
  const drawButton=wrapper.get('.source-region-start');
  expect(drawButton.attributes('aria-pressed')).toBe('false');
  await drawButton.trigger('click');
  expect(drawButton.text()).toBe('框选中 · 退出');
  expect(drawButton.attributes('aria-pressed')).toBe('true');
  await drawButton.trigger('click');
  expect(drawButton.text()).toBe('开始框选');
  expect(canvas.attributes('style')).toContain('pointer-events: none');
  await drawButton.trigger('click');
  await canvas.trigger('pointerdown',{pointerId:1,button:0,clientX:140,clientY:90});
  await canvas.trigger('pointermove',{pointerId:1,clientX:300,clientY:150});
  await canvas.trigger('pointerup',{pointerId:1,clientX:300,clientY:150});
  expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{box:[.1,.2,.5,.5],rotation:0}]);
  expect(canvas.attributes('style')).toContain('pointer-events: none');
  expect(drawButton.text()).toBe('开始框选');
  expect(drawButton.attributes('aria-pressed')).toBe('false');
  await wrapper.setProps({modelValue:{box:[.1,.2,.5,.5],rotation:0}});
  await wrapper.findAll('button').find(b=>b.text()==='清除定位')!.trigger('click');
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null]);
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
it.each([0,90,180,270])('draws the same source rectangle at %s degrees after zoom and cancels interrupted touch gestures',async angle=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const wrapper=mount(Picker,{props:{src:'/synthetic.png',pageKey:'p',coordinateRotation:90,modelValue:null}});
 try{
  await wrapper.get('img').trigger('load');
  await wrapper.get('[aria-label="放大框选原图"]').trigger('click');
  expect(wrapper.text()).toContain('150%');
  wrapper.findComponent({name:'OriginalOrientation'}).vm.$emit('rotationChange',angle);await wrapper.vm.$nextTick();
  const canvas=wrapper.get('.source-region-canvas');
  canvas.element.getBoundingClientRect=()=>({left:10,top:20,width:600,height:300} as DOMRect);
  (canvas.element as HTMLElement).setPointerCapture=vi.fn();
  await wrapper.findAll('button').find(b=>b.text()==='开始框选')!.trigger('click');
  await canvas.trigger('pointerdown',{pointerId:2,button:0,clientX:20,clientY:30});
  await canvas.trigger('pointercancel',{pointerId:2});
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  const displayed=rotateRegionBox([.1,.2,.5,.5],angle);
  await canvas.trigger('pointerdown',{pointerId:3,button:0,clientX:10+600*displayed[0],clientY:20+300*displayed[1]});
  await canvas.trigger('pointerup',{pointerId:3,clientX:10+600*displayed[2],clientY:20+300*displayed[3]});
  const region=(wrapper.emitted('update:modelValue')![0][0] as {box:number[];rotation:number});
  expect(region.box).toEqual([.1,.2,.5,.5].map(v=>expect.closeTo(v)));
  expect(region.rotation).toBe(90);
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
it('keeps rotation beside drawing and zoom controls without an extra image toolbar row',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const wrapper=mount(Picker,{attachTo:document.body,props:{src:'/synthetic.png',pageKey:'p',coordinateRotation:0,modelValue:null}});
 try{
  const viewport=wrapper.get('.original-orientation-viewport').element;
  Object.defineProperty(viewport,'clientWidth',{value:400});
  Object.defineProperties(wrapper.get('img').element,{naturalWidth:{value:800},naturalHeight:{value:1200}});
  await wrapper.get('img').trigger('load');await wrapper.vm.$nextTick();
  const tools=wrapper.get('.source-region-tools');
  expect(tools.find('[aria-label="顺时针旋转 90°"]').exists()).toBe(true);
  expect(wrapper.get('.source-region-scroll').find('.original-orientation-toolbar').exists()).toBe(false);
  await tools.get('[aria-label="顺时针旋转 90°"]').trigger('click');
  expect(wrapper.get('.original-orientation-content').attributes('style')).toContain('rotate(90deg)');
  expect(tools.text()).toContain('100%');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
it('fits the full page within both viewport dimensions and refits rotation and resizing',async()=>{
 const observers:Array<()=>void>=[];
 vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){observers.push(callback);}observe(){}disconnect(){}});
 const wrapper=mount(Picker,{attachTo:document.body,props:{src:'/synthetic.png',pageKey:'p',coordinateRotation:0,modelValue:null}});
 try{
  const viewport=wrapper.get('.source-region-scroll').element;
  Object.defineProperties(viewport,{clientWidth:{value:800,configurable:true},clientHeight:{value:400,configurable:true}});
  Object.defineProperties(wrapper.get('img').element,{naturalWidth:{value:1000},naturalHeight:{value:2000}});
  await wrapper.get('img').trigger('load');observers.forEach(callback=>callback());await wrapper.vm.$nextTick();
  expect(wrapper.get('.source-region-stage').attributes('style')).toContain('width: 200px');
  await wrapper.get('[aria-label="放大框选原图"]').trigger('click');
  expect(wrapper.get('.source-region-stage').attributes('style')).toContain('width: 300px');
  await wrapper.get('[aria-label="缩小框选原图"]').trigger('click');
  wrapper.findComponent({name:'OriginalOrientation'}).vm.$emit('rotationChange',90);await wrapper.vm.$nextTick();
  expect(wrapper.get('.source-region-stage').attributes('style')).toContain('width: 800px');
  Object.defineProperty(viewport,'clientWidth',{value:600});observers.forEach(callback=>callback());await wrapper.vm.$nextTick();
  expect(wrapper.get('.source-region-stage').attributes('style')).toContain('width: 600px');
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
