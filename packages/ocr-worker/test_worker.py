import importlib.util
import math
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "health_records_ocr_worker", Path(__file__).with_name("worker.py")
)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(worker)


def ocr_line(text, confidence, x1, y1, x2, y2, variant=None):
    line = {
        "text": text,
        "confidence": confidence,
        "box": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
    }
    if variant:
        line["variant"] = variant
    return line


class TableRetryTest(unittest.TestCase):
    def test_prefixed_flag_cells_use_upright_pixel_consensus_and_protect_unresolved_values(self):
        import cv2
        import numpy as np
        import tempfile
        source = [ocr_line(text, .99, col * 200, y, col * 200 + 90, y + 20)
                  for y, cells in [(10, ['Test', 'Result', 'Reference', 'Unit']),
                                   (60, ['Synthetic', '↑77', '1-10', 'U/L'])]
                  for col, text in enumerate(cells)]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.png'
            cv2.imwrite(str(path), np.full((150, 900, 3), 255, dtype=np.uint8))
            for replies in [('7.7↓', '7.7↓'), ('7.7↓', '77↑')]:
                answers = iter(replies)
                def engine(_, **kwargs):
                    self.assertIs(kwargs.get('use_cls'), False)
                    return [([[90, 12], [240, 12], [240, 60], [90, 60]], next(answers), .99)], None
                result, attempts = worker.retry_missing_header_cells(engine, path, source)
                self.assertEqual(len(attempts), 2)
                cell = next(line for line in result if line['text'] in ('7.7↓', '↑77'))
                self.assertEqual(cell['text'], '7.7↓' if replies[0] == replies[1] else '↑77')
                if replies[0] != replies[1]:
                    self.assertLess(cell['confidence'], .65)
            context = worker.PageRetryContext(); context.budget['retryCallLimit'] = 0
            protected, attempts = worker.retry_missing_header_cells(engine, path, source, retry_context=context)
            self.assertEqual(attempts, [])
            self.assertLess(next(line for line in protected if line['text'] == '↑77')['confidence'], .65)
            self.assertEqual(source[5]['confidence'], .99)
            self.assertEqual(worker.header_retry_regions(source[4:], 900, 150), [])
            wrapped = [*source[:4], {**source[4], 'box': [[0, 60], [90, 60], [90, 75], [0, 75]]},
                       {**source[5], 'box': [[200, 60], [290, 60], [290, 95], [200, 95]]}, *source[6:]]
            region = next(r for r in worker.header_retry_regions(wrapped, 900, 150)
                          if r['kind'] == 'result' and r.get('original') is wrapped[5])
            self.assertLessEqual(region['crop'][1], 60)
            self.assertGreaterEqual(region['crop'][3], 95)

    def test_low_confidence_flag_glyph_rereads_the_original_cell_without_changing_digits(self):
        source = [ocr_line('Synthetic', .99, 10, 60, 110, 90),
                  ocr_line('24.6t', .81, 450, 60, 510, 90),
                  ocr_line('10-30', .99, 720, 60, 810, 90)]
        headers = [ocr_line('项目', .99, 10, 10, 110, 35), ocr_line('结果', .99, 450, 10, 510, 35),
                   ocr_line('参考范围', .99, 720, 10, 810, 35)]
        rows = [row for row in worker.header_retry_regions(headers + source, 1200, 900)
                if row['kind'] == 'result' and row.get('original') is source[1]]
        self.assertEqual(len(rows), 1)
        self.assertIsNone(worker.table_result_value('24.6t'))
        self.assertTrue(worker.retry_replacement_allowed({'result': source[1]}, 24.6))
        self.assertFalse(worker.retry_replacement_allowed({'result': source[1]}, 246))
        self.assertFalse(worker.retry_replacement_allowed({'result': source[1]}, None))
        for text, confidence in [('24.6t', .99), ('24.6mg', .81)]:
            other = [source[0], {**source[1], 'text': text, 'confidence': confidence}, source[2]]
            self.assertTrue(all(row.get('original') is not other[1]
                                for row in worker.header_retry_regions(headers + other, 1200, 900)))

    def test_word_positions_split_fused_columns_but_do_not_invent_or_change_text(self):
        boxes = [[[x,10],[x+20,10],[x+20,30],[x,30]] for x in (10,31,180,201,330,351)]
        words = ['项','目','12','.5','单','位']
        item = [[[10,10],[371,10],[371,30],[10,30]], ''.join(words), .99, boxes, words, [.98]*6]
        lines = worker.normalize_result([item])
        self.assertEqual([line['text'] for line in lines], ['项目','12.5','单位'])
        self.assertEqual([worker.line_rect(line) for line in lines], [(10.,10.,51.,30.),(180.,10.,221.,30.),(330.,10.,371.,30.)])
        self.assertEqual(len({line['id'] for line in lines}),3)
        bad = [*item[:4], ['错',*words[1:]], item[5]]
        self.assertEqual(worker.normalize_result([bad])[0]['text'],item[1])
        self.assertEqual(len(worker.normalize_result([bad])),1)
        self.assertEqual(worker.normalize_result([item[:3]])[0]['box'],item[0])
        self.assertFalse(worker.sideways_table(lines))

    def test_positioned_spaces_do_not_bridge_columns_or_reduce_field_confidence(self):
        words = ['项','目',' ',' ','结','果']
        boxes = [[[x,10],[x+20,10],[x+20,30],[x,30]] for x in (10,30,50,90,130,150)]
        item = [[[10,10],[170,10],[170,30],[10,30]], ''.join(words), .96,
                boxes, words, [.98,.94,0.,0.,.99,.97]]
        lines = worker.normalize_result([item])
        self.assertEqual([line['text'] for line in lines], ['项目','结果'])
        self.assertEqual([worker.line_rect(line) for line in lines], [(10.,10.,50.,30.),(130.,10.,170.,30.)])
        self.assertAlmostEqual(lines[0]['confidence'],.96)
        self.assertAlmostEqual(lines[1]['confidence'],.98)
        # Spaces inside a field are retained; a low confidence digit remains low.
        ordinary_words = ['合','成',' ',' ','甲','乙']
        narrow = [item[0], ''.join(ordinary_words), item[2],
                  [[[x,10],[x+20,10],[x+20,30],[x,30]] for x in (10,30,50,55,60,80)], ordinary_words, item[5]]
        self.assertEqual(worker.normalize_result([narrow])[0]['text'],narrow[1])
        low = [*item[:5], [.98,.94,0.,0.,.2,.3]]
        self.assertAlmostEqual(worker.normalize_result([low])[1]['confidence'],.25)
        flipped = [*item[:3], list(reversed(boxes)), *item[4:]]
        self.assertEqual(worker.normalize_result([flipped])[0]['box'],item[0])

    def test_packed_headings_use_glyph_positions_without_splitting_values(self):
        words = list('参考范围单位序')
        xs = [10,30,50,70,115,135,180]
        boxes = [[[x,10],[x+18,10],[x+18,30],[x,30]] for x in xs]
        item = [[[10,10],[198,10],[198,30],[10,30]], ''.join(words), .99, boxes, words, [.99]*len(words)]
        lines = worker.normalize_result([item])
        self.assertEqual([l['text'] for l in lines], ['参考范围','单位','序'])
        self.assertEqual([worker.line_rect(l) for l in lines],[(10.,10.,88.,30.),(115.,10.,153.,30.),(180.,10.,198.,30.)])
        # A recognition token spanning the label boundary has no finer geometry.
        joined = [*item[:3], [item[0]], [item[1]], [.99]]
        self.assertEqual(worker.normalize_result([joined])[0]['box'],item[0])

    def test_sideways_table_retry_is_bounded_and_restores_original_coordinates(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pillow runtime is unavailable')
        import tempfile
        from unittest.mock import patch
        sideways = [ocr_line('项目名称' if i == 0 else '结果' if i == 1 else 'Synthetic', .99,
                             10+i*30, 20, 28+i*30, 200) for i in range(8)]
        upright = [ocr_line('项目名称', .99, 20, 10, 140, 30), ocr_line('结果', .99, 220, 10, 280, 30)]
        upright += [ocr_line('Synthetic', .99, 20, 60+i*30, 140, 80+i*30) for i in range(4)]
        def result(lines):
            return [(line['box'], line['text'], line['confidence']) for line in lines], None
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'sideways.png'
            Image.new('RGB', (300, 500), 'white').save(path)
            for chosen in (90, 270):
                calls = []
                def engine(value):
                    calls.append(Path(value).name)
                    return result(upright if Path(value).name == f'turn-{chosen}.png' else sideways)
                with patch.object(worker, 'photo_perspective_variant', return_value=None), \
                     patch.object(worker, 'retry_missing_header_cells', side_effect=lambda e,p,l,**kw:(l,[])), \
                     patch.object(worker, 'retry_suspicious_table_rows', side_effect=lambda e,p,l,**kw:(l,[])), \
                     patch.object(worker, 'enhance_page_lines', side_effect=lambda p,l:l):
                    lines, metadata = worker.recognize_image(engine,path,None)
                self.assertEqual(len(calls),3, 'reuse the winning OCR response and bound direction retries')
                self.assertEqual(metadata['rotation'],chosen)
                self.assertEqual(lines[0]['text'],'项目名称')
                for line in lines:
                    self.assertTrue(all(0<=x<=300 and 0<=y<=500 for x,y in line['box']))
                corrected = worker.rotate_point_box(worker.line_rect(lines[0]), chosen, 300, 500)
                self.assertEqual(corrected, list(worker.line_rect(upright[0])))
            def failed_retry(value):
                if Path(value).name.startswith('turn-'):
                    raise ValueError('synthetic failure')
                return result(sideways)
            with patch.object(worker, 'photo_perspective_variant', return_value=None), \
                 patch.object(worker, 'retry_missing_header_cells', side_effect=lambda e,p,l,**kw:(l,[])), \
                 patch.object(worker, 'retry_suspicious_table_rows', side_effect=lambda e,p,l,**kw:(l,[])), \
                 patch.object(worker, 'enhance_page_lines', side_effect=lambda p,l:l):
                lines, _ = worker.recognize_image(failed_retry,path,None)
            self.assertEqual(len(lines),len(sideways))
            self.assertEqual(lines[0]['box'],sideways[0]['box'])

    def test_pdf_append_bin_supports_inspection_thumbnail_and_ocr(self):
        try:
            import fitz
            from PIL import Image
        except ImportError:
            self.skipTest('PyMuPDF/Pillow runtime is unavailable')
        import io, json, os, tempfile
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'OCR_TABLE_ENHANCEMENT': 'off'}):
            root = Path(root)
            with fitz.open() as document:
                document.new_page(width=600, height=800)
                page = document.new_page(width=600, height=800)
                for n in range(8):
                    page.insert_text((20, 100+n*80), 'Synthetic append row '+str(n)+' '+('x'*45), fontsize=10)
                data = document.tobytes()

            def no_ocr(_):
                self.fail('Complete PDF text should use the text layer')

            outputs = []
            for suffix in ('.pdf', '.bin'):
                source = root / ('append'+suffix)
                source.write_bytes(data)
                thumbnail = root / ('preview'+suffix+'.jpg')
                requests = [
                    {'id': 'inspect', 'action': 'inspect_pdf', 'imagePath': str(source), 'mimeType': 'application/pdf'},
                    {'id': 'thumbnail', 'action': 'thumbnail', 'imagePath': str(source), 'mimeType': 'application/pdf',
                     'outputPath': str(thumbnail), 'pageNumber': 2, 'rotation': 90},
                    {'id': 'ocr', 'action': 'ocr', 'imagePath': str(source), 'mimeType': 'application/pdf',
                     'pageNumber': 2, 'rotation': 90},
                ]
                stdout = io.StringIO()
                with patch.object(worker.sys, 'stdin', io.StringIO('\n'.join(map(json.dumps, requests)))), \
                     patch.object(worker.sys, 'stdout', stdout), \
                     patch.object(worker, 'load_engine', return_value={'engine': no_ocr, 'name': 'synthetic'}):
                    self.assertEqual(worker.run_daemon(), 0)
                responses = {item['id']: item for item in map(json.loads, stdout.getvalue().splitlines()) if 'id' in item}
                for request in requests:
                    self.assertTrue(responses[request['id']]['ok'], responses[request['id']])
                self.assertEqual(responses['inspect']['pageCount'], 2)
                with Image.open(thumbnail) as image:
                    self.assertGreater(image.width, image.height)
                self.assertEqual(responses['ocr']['coordWidth'], 800)
                self.assertEqual(responses['ocr']['coordHeight'], 600)
                self.assertEqual(len(responses['ocr']['lines']), 8)
                outputs.append(responses['ocr']['lines'])
            self.assertEqual(outputs[0], outputs[1])

            # Scanned PDFs must also render through the PDF branch for OCR.
            with patch.object(worker, 'should_ocr_pdf_page', return_value=True), \
                 patch.object(worker, 'recognize_image', return_value=([], None)) as recognize:
                lines, metadata, coord = worker.recognize_input(no_ocr, source, None, 2, 90)
            recognize.assert_called_once()
            self.assertEqual(metadata['source'], 'pdf_text_plus_render')
            self.assertEqual([(line['text'], line['box']) for line in lines],
                             [(line['text'], line['box']) for line in outputs[1]])
            self.assertEqual(coord, {'coordWidth': 800., 'coordHeight': 600.})

    def test_small_skew_keeps_uncertain_results_in_their_own_rows(self):
        for angle in (-4,-2,0,2,4):
            with self.subTest(angle=angle):
                c,s=math.cos(math.radians(angle)),math.sin(math.radians(angle))
                source=[ocr_line('Synthetic',.99,10,80,110,98),ocr_line('12.5',.5,450,80,510,98),
                        ocr_line('Other',.99,10,120,110,138),ocr_line('24.6',.99,450,120,510,138)]
                def rotate(lines):
                    return [{**line,'box':[[100+c*x-s*y,100+s*x+c*y] for x,y in line['box']]} for line in lines]
                for has_reference in (False,True):
                    lines=rotate(source+([ocr_line('0-99',.99,850,80,920,98),ocr_line('0-99',.99,850,120,920,138)] if has_reference else []))
                    rows=worker.suspicious_table_rows(lines,1300,700)
                    self.assertEqual(len(rows),1)
                    row=rows[0]
                    self.assertEqual(row['name']['text'],'Synthetic')
                    self.assertEqual(row['result']['text'],'12.5')
                    own_row=worker.table_row_lines(lines,row['nameRect'],row['referenceRect'],row['slope'])
                    self.assertNotIn('24.6',[line['text'] for line in own_row])
                    bounds=worker.line_rect(row['result']);crop=row['crop']
                    self.assertLessEqual(crop[0],bounds[0]);self.assertGreaterEqual(crop[2],bounds[2])
                    self.assertLessEqual(crop[1],bounds[1]);self.assertGreaterEqual(crop[3],bounds[3])

    def test_tilted_header_crops_follow_the_missing_cell_row(self):
        for angle in (-4,4):
            c,s=math.cos(math.radians(angle)),math.sin(math.radians(angle))
            source=[ocr_line('Test',.99,10,10,80,28),ocr_line('Result',.99,450,10,520,28),
                    ocr_line('Unit',.99,700,10,750,28),ocr_line('Synthetic',.99,10,100,110,118)]
            rotate=lambda x,y:(100+c*x-s*y,100+s*x+c*y)
            lines=[{**line,'box':[rotate(x,y) for x,y in line['box']]} for line in source]
            regions=worker.header_retry_regions(lines,1300,700)
            self.assertEqual([r['kind'] for r in regions],['result','unit'])
            for region,point in zip(regions,[(480,109),(720,109)]):
                x,y=rotate(*point);left,top,right,bottom=region['crop']
                self.assertTrue(left<x<right and top<y<bottom)

    def test_retry_caps_leave_counted_work_without_invalidating_table_cells(self):
        lines=[]
        for n in range(20):
            lines.extend([ocr_line('Synthetic'+str(n),.99,10,50+n*30,110,68+n*30),
                          ocr_line('12.5',.5,450,50+n*30,510,68+n*30)])
        self.assertEqual(len(worker.suspicious_table_rows(lines,1200,900,limit=None)),20)
        self.assertEqual(len(worker.suspicious_table_rows(lines,1200,900)),12)
        headers=[ocr_line('Test',.99,10,10,80,28),ocr_line('Result',.99,450,10,520,28),ocr_line('Unit',.99,700,10,750,28)]
        missing=headers+lines[::2]
        self.assertEqual(len(worker.header_retry_regions(missing,1200,900,limit=None)),40)
        self.assertEqual(len(worker.header_retry_regions(missing,1200,900)),8)
        source=[{**lines[0],'tableCell':{'table':'t','row':1,'column':0,'columns':3},'tableDiagnostics':{'status':'applied','mapped':1,'unsafe':0}}]
        budget=dict(rowCandidates=20,rowRetried=12,rowRemaining=8,cellCandidates=40,cellRetried=8,cellRemaining=32)
        annotated=worker.annotate_retry_budget(source,budget)
        self.assertEqual(annotated[0]['tableRetryBudget'],budget)
        self.assertEqual(annotated[0]['tableCell'],source[0]['tableCell'])
        self.assertEqual(annotated[0]['tableDiagnostics']['status'],'applied')
        self.assertNotIn('tableRetryBudget',source[0])

    def test_pdf_intrinsic_rotation_matches_text_and_render_coordinates(self):
        try:
            import fitz
            import PIL
        except ImportError:
            self.skipTest('PyMuPDF/Pillow runtime is unavailable')
        import tempfile,os
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'OCR_TABLE_ENHANCEMENT':'off'}):
            path=Path(root)/'rotated.pdf'
            with fitz.open() as document:
                page=document.new_page(width=600,height=800)
                for n in range(8):
                    page.insert_text((20,100+n*80),'Synthetic row '+str(n)+' '+('x'*45),fontsize=10)
                page.set_rotation(90)
                document.save(path)
            with fitz.open(path) as document:
                page=document[0]
                expected=[(line['spans'][0]['text'],list(fitz.Rect(line['bbox'])*page.rotation_matrix))
                          for block in page.get_text('dict')['blocks'] if block['type']==0 for line in block['lines']]
            self.assertEqual(len(expected),8)
            def no_ocr(_):self.fail('A complete text layer should stay on the fast path')
            lines,meta,coord=worker.recognize_input(no_ocr,path,None,1)
            self.assertEqual(meta['source'],'pdf_text')
            self.assertEqual(coord,{'coordWidth':800.,'coordHeight':600.})
            self.assertEqual([line['box'] for line in lines],[box for _,box in expected])
            for line in lines:
                x1,y1,x2,y2=line['box']
                self.assertTrue(0<=x1<x2<=800 and 0<=y1<y2<=600)
            rotated,_,swapped=worker.recognize_input(no_ocr,path,None,1,90)
            self.assertEqual(swapped,{'coordWidth':600.,'coordHeight':800.})
            # PDF text and image OCR at identical visible positions must fuse once.
            def rendered_ocr(_):
                return [([[x1*3,y1*3],[x2*3,y1*3],[x2*3,y2*3],[x1*3,y2*3]],text,.99)
                        for text,(x1,y1,x2,y2) in expected],None
            with patch.object(worker,'should_ocr_pdf_page',return_value=True):
                fused,meta,_=worker.recognize_input(rendered_ocr,path,None,1)
            self.assertEqual(meta['source'],'pdf_text_plus_render')
            self.assertEqual(len(fused),8)

    def test_photo_rectification_preserves_original_coordinates_and_skips_scans(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile,os
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'OCR_TABLE_ENHANCEMENT':'off'}):
            root=Path(root)
            paper=np.full((400,900,3),255,dtype=np.uint8)
            cv2.putText(paper,'Synthetic 12.5',(80,180),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),2)
            original=np.float32([[0,0],[899,0],[899,399],[0,399]])
            corners=np.float32([[180,70],[890,100],[990,520],[80,550]])
            matrix=cv2.getPerspectiveTransform(original,corners)
            photo=cv2.warpPerspective(paper,matrix,(1080,620),borderValue=(50,50,50))
            path=root/'photo.png';cv2.imwrite(str(path),photo)
            prepared=worker.photo_perspective_variant(path,root)
            self.assertIsNotNone(prepared)
            corrected,inverse,width,height=prepared
            image=cv2.imread(str(corrected));h,w=image.shape[:2]
            restored=worker.restore_photo_coordinates([ocr_line('Synthetic',.99,0,0,w-1,h-1)],inverse,width,height)
            self.assertTrue(np.allclose(restored[0]['box'],corners,atol=4))
            calls=[]
            def engine(filename):
                calls.append(filename)
                return [([[20,20],[80,20],[80,40],[20,40]],'Synthetic',.99)],None
            lines,meta=worker.recognize_image(engine,path,None)
            self.assertEqual(len(calls),1)
            self.assertEqual(meta['source'],'photo_perspective')
            a,b,c,d=worker.line_rect(lines[0])
            self.assertTrue(0<a<c<1080 and 0<b<d<620)
            cv2.imwrite(str(root/'scan.png'),paper)
            self.assertIsNone(worker.photo_perspective_variant(root/'scan.png',root))
            # Do not infer missing corners for a cropped sheet.
            cv2.imwrite(str(root/'cropped.png'),photo[100:500,100:950])
            self.assertIsNone(worker.photo_perspective_variant(root/'cropped.png',root))

    def test_mixed_pdf_ocr_visits_only_uncovered_image_regions_and_reports_cap(self):
        try:
            import fitz
            from PIL import Image,ImageDraw
        except ImportError:
            self.skipTest('PyMuPDF/Pillow runtime is unavailable')
        import tempfile,os,io
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'OCR_TABLE_ENHANCEMENT':'off'}):
            image=Image.new('RGB',(800,240),'white')
            ImageDraw.Draw(image).text((30,40),'Synthetic marker 12.5 U/L',fill='black')
            buffer=io.BytesIO();image.save(buffer,format='PNG');image.close()
            def pdf(name,boxes,covered=False,intrinsic=0):
                path=Path(root)/name
                with fitz.open() as document:
                    page=document.new_page(width=600,height=800)
                    for n in range(25):
                        page.insert_text((20,25+n*12),f'Fixture description {n} '+('x'*62),fontsize=8)
                    for box in boxes:page.insert_image(fitz.Rect(box),stream=buffer.getvalue(),keep_proportion=False)
                    if covered:page.insert_text((110,430),'Covered 12.5 U/L',fontsize=10)
                    page.set_rotation(intrinsic);document.save(path)
                return path
            calls=[]
            def engine(path):
                with Image.open(path) as crop:calls.append(crop.size)
                return [([[30,30],[150,30],[150,60],[30,60]],'12.5',.99)],None
            path=pdf('image.pdf',[(100,400,500,520)])
            lines,meta,_=worker.recognize_input(engine,path,None,1)
            self.assertEqual(meta['source'],'pdf_text_plus_regions')
            self.assertEqual(calls,[(1200,360)])
            result=next(line for line in lines if line['text']=='12.5')
            self.assertEqual(worker.line_rect(result),(110.,410.,150.,420.))
            self.assertEqual(meta['tableRetryBudget']['imageRetried'],1)
            calls.clear()
            path=pdf('intrinsic.pdf',[(100,400,500,520)],intrinsic=90)
            lines,_,_=worker.recognize_input(engine,path,None,1,270)
            self.assertEqual(calls,[(1200,360)])
            self.assertEqual(worker.line_rect(next(line for line in lines if line['text']=='12.5')),(110.,410.,150.,420.))
            for name,boxes,covered in [('logo.pdf',[(30,400,70,440)],False),('covered.pdf',[(100,400,500,520)],True)]:
                calls.clear()
                _,meta,_=worker.recognize_input(engine,pdf(name,boxes,covered),None,1)
                self.assertEqual(meta['source'],'pdf_text')
                self.assertEqual(calls,[])
            calls.clear()
            path=pdf('many.pdf',[(100,400+n*50,300,430+n*50) for n in range(4)])
            lines,meta,_=worker.recognize_input(engine,path,None,1)
            self.assertEqual(len(calls),3)
            self.assertEqual(meta['tableRetryBudget']['imageCandidates'],4)
            self.assertEqual(meta['tableRetryBudget']['imageRemaining'],1)
            self.assertEqual(lines[0]['tableRetryBudget']['imageRemaining'],1)
            def failed_ocr(_):
                raise RuntimeError('Synthetic OCR failure')
            lines, meta, _ = worker.recognize_input(failed_ocr, path, None, 1)
            self.assertEqual(len(lines), 25)
            self.assertEqual(meta['tableRetryBudget']['imageRetried'], 3)
            self.assertEqual(lines[0]['tableRetryBudget']['imageRemaining'], 1)
            self.assertEqual(lines[0]['tableRetryBudget']['imageUnresolved'], 3)
            with patch.dict(os.environ, {'OCR_RETRY_MAX_CALLS_PER_PAGE':'2'}):
                calls.clear()
                lines, meta, _ = worker.recognize_input(engine, path, None, 1)
                self.assertEqual(len(calls), 2)
                self.assertEqual(meta['tableRetryBudget']['retryCalls'], 2)
                self.assertEqual(meta['tableRetryBudget']['imageRemaining'], 2)
            with patch.dict(os.environ, {'OCR_RETRY_MAX_PIXELS_PER_PAGE':'1'}):
                calls.clear()
                lines, meta, _ = worker.recognize_input(engine, path, None, 1)
                self.assertEqual(calls, [])
                self.assertEqual(meta['tableRetryBudget']['retryPixels'], 0)
                self.assertEqual(meta['tableRetryBudget']['imageRemaining'], 4)
            def region_with_missing_cells(filename):
                calls.append(filename)
                if not Path(filename).name.startswith('region-'):
                    return [],None
                items=[ocr_line('Test',.99,10,5,80,23),ocr_line('Result',.99,200,5,270,23),
                       ocr_line('Unit',.99,350,5,400,23),ocr_line('Synthetic',.99,10,50,100,68)]
                return [(line['box'],line['text'],line['confidence']) for line in items],None
            with patch.dict(os.environ, {'OCR_RETRY_MAX_CALLS_PER_PAGE':'3'}):
                calls.clear()
                lines,meta,_=worker.recognize_input(region_with_missing_cells,path,None,1)
                budget=meta['tableRetryBudget']
                self.assertEqual(len(calls),3)  # ROI primary plus two variants, shared by the whole page.
                self.assertEqual(budget['retryCalls'],3)
                self.assertEqual(budget['imageRetried'],1)
                self.assertEqual(budget['imageRemaining'],3)
                self.assertEqual(budget['cellRemaining'],1)
                self.assertEqual(budget['cellUnresolved'],1)
                self.assertEqual(sum('tableRetryBudget' in line for line in lines),1)

    def test_optional_retry_budget_caps_calls_pixels_and_deduplicates_regions(self):
        budget = worker.empty_retry_budget()
        budget.update(retryCallLimit=2,retryPixelLimit=100)
        context = worker.PageRetryContext(budget)
        self.assertTrue(context.reserve(40))
        self.assertFalse(context.reserve(61))
        self.assertTrue(context.reserve(60))
        self.assertFalse(context.reserve(1))
        self.assertEqual((budget['retryCalls'],budget['retryPixels']),(2,100))
        candidates = [{'crop':(10,10,110,50),'kind':'result'},
                      {'crop':(11,10,110,50),'kind':'result'},
                      {'crop':(10,60,110,100),'kind':'result'}]
        self.assertEqual(worker.dedupe_crop_candidates(candidates),[candidates[0],candidates[2]])

    def test_reread_failure_and_no_consensus_remain_unresolved(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile
        from unittest.mock import patch
        source = [ocr_line('Synthetic',.99,10,50,110,70),ocr_line('12.5',.5,450,50,510,70)]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'synthetic.png'
            cv2.imwrite(str(path),np.full((150,900,3),255,dtype=np.uint8))
            for fail in (False,True):
                context=worker.PageRetryContext()
                context.budget['retryCallLimit']=2
                def engine(_):
                    if fail:raise RuntimeError('Synthetic optional failure')
                    return [],None
                lines,_=worker.retry_suspicious_table_rows(engine,path,source,retry_context=context)
                budget=context.budget
                self.assertEqual(budget['rowRetried'],1)
                self.assertEqual(budget['rowRemaining'],0)
                self.assertEqual(budget['rowUnresolved'],1)
                self.assertEqual(budget['retryCalls'],2)
                annotated=worker.annotate_retry_budget(lines,budget)
                self.assertEqual(annotated[0]['tableRetryBudget']['rowUnresolved'],1)
                self.assertEqual([line['text'] for line in lines],[line['text'] for line in source])

    def test_english_and_wrapped_headers_find_missing_cells(self):
        for name, result in [('Test Name', 'Results'), ('项目\n名称', '检验\n结果')]:
            lines = [ocr_line(name,.99,10,10,90,30), ocr_line(result,.99,200,10,270,30),
                     ocr_line('Units',.99,350,10,400,30), ocr_line('Synthetic',.99,10,80,100,100)]
            self.assertEqual([r['kind'] for r in worker.header_retry_regions(lines,500,200)], ['result','unit'])
        lines = [ocr_line('Test',.99,10,10,80,25), ocr_line('Name',.99,10,28,80,43),
                 ocr_line('Results',.99,200,10,270,30), ocr_line('Units',.99,350,10,400,30),
                 ocr_line('Synthetic',.99,10,80,100,100)]
        self.assertEqual([r['kind'] for r in worker.header_retry_regions(lines,500,200)], ['result','unit'])

    def test_code_only_wrapped_name_and_glued_result_are_reread_before_footer(self):
        headers=[ocr_line('项目',.99,40,10,90,30),ocr_line('结果',.99,300,10,360,30),
                 ocr_line('参考区间',.99,500,10,580,30),ocr_line('单位',.99,700,10,750,30)]
        rows=[ocr_line('8合成项目[SYN]18.2',.99,10,70,360,90),
              ocr_line('0-30',.99,500,70,560,90),ocr_line('U/L',.99,700,70,740,90),
              ocr_line('[TEST]',.99,40,150,100,170),
              ocr_line('备注:',.99,10,210,90,230),ocr_line('普通说明文字',.99,10,250,150,270)]
        regions=worker.header_retry_regions(headers+rows,900,400,limit=None)
        self.assertEqual(regions[0]['kind'],'name')
        glued=next(r for r in regions if r['kind']=='result' and r['crop'][1]<100)
        self.assertGreaterEqual(glued['crop'][0],280)
        self.assertEqual(glued['expectedResult'],'18.2')
        self.assertTrue(all(r['crop'][3]<210 for r in regions))

    def test_missing_reference_separators_trigger_reread_without_guessing(self):
        headers=[ocr_line('项目',.99,10,10,90,30),ocr_line('结果',.99,200,10,270,30),
                 ocr_line('参考区间',.99,400,10,490,30),ocr_line('单位',.99,600,10,650,30)]
        for reference in ['0.09.0','2.0 8.0','120240']:
            row=[ocr_line('合成项目',.99,10,70,100,90),ocr_line('5',.99,200,70,240,90),
                 ocr_line(reference,.99,400,70,490,90),ocr_line('U/L',.99,600,70,650,90)]
            regions=worker.header_retry_regions(headers+row,800,150)
            self.assertEqual([r['kind'] for r in regions],['reference'])
            self.assertEqual(regions[0]['original']['text'],reference)

    def test_recovered_wrapped_name_does_not_reintroduce_left_hand_row_number(self):
        import tempfile
        from pathlib import Path
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('image runtime unavailable')
        headers=[ocr_line('项目',.99,40,10,90,30),ocr_line('结果',.99,300,10,360,30)]
        source=headers+[ocr_line('7',.99,20,100,40,120),ocr_line('[SYN]',.99,60,100,110,120)]
        def engine(_):
            return [([[60,3],[600,3],[600,48],[60,48]],'合成项目',.99),
                    ([[3,40],[60,40],[60,85],[3,85]],'7',.99),
                    ([[120,50],[270,50],[270,95],[120,95]],'[SYN]',.99)],None
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'synthetic.png'
            cv2.imwrite(str(path),np.full((250,900,3),255,dtype=np.uint8))
            result,_=worker.retry_missing_header_cells(engine,path,source)
        texts=[line['text'] for line in result]
        self.assertIn('合成项目[SYN]',texts)
        self.assertNotIn('7',texts)
        self.assertNotIn('[SYN]',texts)

    def test_low_confidence_short_and_english_items_without_reference_are_reread(self):
        for name in ['合成', 'TEST']:
            lines=[ocr_line(name,.99,10,50,100,70),ocr_line('12.5',.5,200,50,260,70)]
            rows=worker.suspicious_table_rows(lines,800,500)
            self.assertEqual(len(rows),1)
            self.assertIsNone(rows[0]['reference'])
            self.assertEqual(rows[0]['result']['text'],'12.5')

    def test_retry_requires_agreement_and_never_uses_reference_to_choose_a_value(self):
        a=ocr_line('12.5',.95,0,0,60,20,'upscale')
        b=ocr_line('12.5',.94,0,0,60,20,'gray')
        c=ocr_line('1.25',.99,0,0,60,20,'gray')
        self.assertIsNone(worker.consensus_retry_result([a,c]))
        self.assertEqual(worker.consensus_retry_result([a,b])['text'],'12.5')
        self.assertEqual(worker.retry_result_score(a,(0,2)),worker.retry_result_score(a,(0,20)))
        original={"resultExtreme":True,"resultCorrupt":False,"result":{"text":"72"}}
        self.assertFalse(worker.retry_replacement_allowed(original,5.2))
        self.assertTrue(worker.retry_replacement_allowed(original,72))
        marked={"resultExtreme":True,"resultCorrupt":True,"result":{"text":"↑72","confidence":.99}}
        self.assertFalse(worker.retry_replacement_allowed(marked,5.2))
        self.assertTrue(worker.retry_replacement_allowed(marked,72))

    def test_missing_cell_regions_require_explicit_headers_and_preserve_blank_units(self):
        lines=[ocr_line(text,.99,col*200,row*50,col*200+90,row*50+20)
               for row,cells in enumerate([['项目名称','结果','单位','参考范围'],['合成项目','12.5','','0-99']])
               for col,text in enumerate(cells) if text]
        regions=worker.header_retry_regions(lines,900,300)
        self.assertEqual(len(regions),1)
        self.assertEqual(regions[0]['kind'],'unit')
        self.assertGreater(regions[0]['crop'][0],290)
        self.assertLess(regions[0]['crop'][2],600)
        self.assertEqual(worker.header_retry_regions(lines[4:],900,300),[])
        merged_unit = ocr_line('0-99 U/L', .99, 430, 50, 710, 70)
        self.assertEqual(worker.header_retry_regions([*lines, merged_unit],900,300),[])

    def test_qualitative_blank_units_require_a_clear_result_in_the_same_row(self):
        headers = [ocr_line(text,.99,col*200,10,col*200+90,30)
                   for col,text in enumerate(['Test','Result','Unit','Reference'])]
        name = ocr_line('Synthetic',.99,0,60,90,80)
        for value in ('阴性','阳性','未检出','negative','Positive','阴性(-)'):
            lines=headers+[name,ocr_line(value,.99,200,60,260,80)]
            self.assertEqual(worker.header_retry_regions(lines,900,200),[])
        for value in ('12.5','unreadable','-'):
            lines=headers+[name,ocr_line(value,.99,200,60,260,80)]
            self.assertEqual([r['kind'] for r in worker.header_retry_regions(lines,900,200)],['unit'])
        # A reference cell or neighbouring row cannot excuse a missing numeric unit.
        lines=headers+[name,ocr_line('12.5',.99,200,60,260,80),
                       ocr_line('阴性',.99,600,60,690,80),ocr_line('阴性',.99,200,120,290,140)]
        self.assertEqual([r['kind'] for r in worker.header_retry_regions(lines,900,200)],['unit'])

    def test_centered_result_heading_keeps_room_for_leading_digits(self):
        lines = [ocr_line('项目名称', .99, 100, 10, 200, 30),
                 ocr_line('结果', .99, 520, 10, 560, 30),
                 ocr_line('单位', .99, 700, 10, 740, 30),
                 ocr_line('合成项目', .99, 100, 60, 300, 80)]
        result = next(region for region in worker.header_retry_regions(lines, 900, 300)
                      if region['kind'] == 'result')
        # The printed value may start left of its centred heading.
        self.assertLess(result['crop'][0], 470)
        self.assertGreater(result['crop'][2], 580)

    def test_descending_reference_requires_explicit_column_before_rereading(self):
        headers = [ocr_line(text, .99, col * 200, 10, col * 200 + 90, 30)
                   for col, text in enumerate(['Test', 'Result', 'Unit', 'Reference'])]
        row = [ocr_line(text, .99, col * 200, 60, col * 200 + 90, 80)
               for col, text in enumerate(['Synthetic', '12.5', 'U/L', '66-0'])]
        regions = worker.header_retry_regions(headers + row, 900, 150)
        self.assertEqual([region['kind'] for region in regions], ['reference'])
        self.assertIs(regions[0]['original'], row[-1])
        self.assertLessEqual(regions[0]['crop'][1], 48)
        self.assertGreaterEqual(regions[0]['crop'][3], 92)
        self.assertEqual(worker.header_retry_regions(row, 900, 150), [])
        self.assertEqual(worker.header_retry_regions(headers + row[:-1] + [
            {**row[-1], 'text': '0-99'}], 900, 150), [])
        later_rows = [{**line, 'box': [[x, y + offset] for x, y in line['box']]}
                      for offset in (35, 70) for line in row]
        regions = worker.header_retry_regions(headers + row + later_rows, 900, 180)
        self.assertEqual(len(regions), 3)
        # Padding stops before the neighbouring row's printed reference text.
        self.assertLess(regions[0]['crop'][3], 95)
        self.assertGreater(regions[1]['crop'][1], 80)

    def test_reference_reread_replaces_only_with_agreeing_pixel_results(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile
        lines = [ocr_line(text, .99, col * 200, y, col * 200 + 90, y + 20)
                 for y, cells in [(10, ['Test', 'Result', 'Unit', 'Reference']),
                                  (60, ['Synthetic', '12.5', 'U/L', '66-0'])]
                 for col, text in enumerate(cells)]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.png'
            cv2.imwrite(str(path), np.full((150, 900, 3), 255, dtype=np.uint8))
            for replies, expected in [(('0-99', '0-99'), '0-99'),
                                      (('0-99', '0-66'), '66-0'),
                                      (('66-0', '66-0'), '66-0')]:
                with self.subTest(replies=replies):
                    answers = iter(replies)
                    def engine(_):
                        # Coordinates lie inside both renderings of the crop.
                        return [([[90, 12], [240, 12], [240, 60], [90, 60]],
                                 next(answers), .99)], None
                    budget=worker.empty_retry_budget()
                    result, attempts = worker.retry_missing_header_cells(engine, path, lines,budget)
                    self.assertEqual([line['text'] for line in result],
                                     [line['text'] for line in lines[:-1]] + [expected])
                    self.assertEqual(len(attempts), 2)
                    self.assertEqual(lines[-1]['text'], '66-0')
                    self.assertEqual(budget['cellRemaining'],0)
                    self.assertEqual(budget['cellUnresolved'],0 if expected=='0-99' else 1)

    def test_high_confidence_fraction_unit_after_reference_requires_pixel_consensus(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile
        lines = [ocr_line(text, .99, col * 200, y, col * 200 + 90, y + 20)
                 for y, cells in [(10, ['Test', 'Result', 'Reference', 'Unit']),
                                  (60, ['Synthetic', '18.2', '0-99', '7/6'])]
                 for col, text in enumerate(cells)]
        regions = worker.header_retry_regions(lines, 900, 150)
        self.assertEqual([r['kind'] for r in regions], ['unit'])
        self.assertIs(regions[0]['original'], lines[-1])
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.png'
            cv2.imwrite(str(path), np.full((150, 900, 3), 255, dtype=np.uint8))
            for replies, expected in [(('g/ L', 'g/L'), 'g/L'),
                                      (('g/L', 'U/L'), '7/6'),
                                      (('7/6', '7/6'), '7/6')]:
                answers = iter(replies)
                def engine(_):
                    return [([[90,12],[240,12],[240,60],[90,60]], next(answers, ""), .99)], None
                budget = worker.empty_retry_budget()
                result, attempts = worker.retry_missing_header_cells(engine, path, lines, budget)
                self.assertEqual([l['text'] for l in result], [l['text'] for l in lines[:-1]] + [expected])
                self.assertEqual(len(attempts), 2 if expected == 'g/L' else 4)
                self.assertEqual(budget['cellUnresolved'], 0 if expected == 'g/L' else 1)
        missing = [ocr_line('Another', .99, 0, 100, 90, 120)]
        first = worker.header_retry_regions(lines + missing, 900, 150, limit=1)
        self.assertIs(first[0]['original'], lines[-1])

    def test_truncated_unit_requires_agreeing_complete_pixel_readings(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile
        lines = [ocr_line(text, .99, col * 200, y, col * 200 + 90, y + 20)
                 for y, cells in [(10, ['Test', 'Result', 'Reference', 'Unit']),
                                  (60, ['Synthetic', '8.4', '0-12', 'mg/'])]
                 for col, text in enumerate(cells)]
        # The wrapped name baseline must not clip the lower unit glyphs.
        lines[-1]['box'] = [[x, y + 10] for x, y in lines[-1]['box']]
        region = worker.header_retry_regions(lines, 900, 150)[0]
        self.assertIs(region['original'], lines[-1])
        self.assertGreaterEqual(region['crop'][3], 94)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.png'
            cv2.imwrite(str(path), np.full((150, 900, 3), 255, dtype=np.uint8))
            for replies, expected in [(('mg/L', 'mg/L'), 'mg/L'),
                                      (('mg/L', 'mg/dL'), 'mg/'),
                                      (('mg/L', 'mg/dL', 'mg/L', 'mg/L'), 'mg/'),
                                      (('mg/', 'mg/'), 'mg/'),
                                      (('m', 'm'), 'mg/'),
                                      (('mg/', 'mg/', 'mg/L', 'mg/L'), 'mg/L')]:
                answers = iter(replies)
                def engine(_):
                    return [([[90,12],[240,12],[240,60],[90,60]], next(answers, ""), .99)], None
                budget = worker.empty_retry_budget()
                result, attempts = worker.retry_missing_header_cells(engine, path, lines, budget)
                self.assertEqual(result[-1]['text'], expected)
                self.assertEqual([a['variant'] for a in attempts], ['cell_binary', 'cell_adaptive'] + ([] if replies[:2] == ('mg/L', 'mg/L') else ['cell_upscale', 'cell_gray']))
                self.assertEqual(budget['retryCalls'], 2 if replies[:2] == ('mg/L', 'mg/L') else 4)
                self.assertEqual(budget['cellUnresolved'], 0 if expected == 'mg/L' else 1)

    def test_wrapped_name_duplicate_unit_crops_do_not_discard_successful_retry(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime is unavailable')
        import tempfile
        from unittest.mock import patch
        original = ocr_line('mg/', .99, 210, 60, 260, 80)
        region = {'kind': 'unit', 'original': original, 'crop': (190, 50, 280, 90)}
        def engine(_):
            return [([[60,30],[210,30],[210,90],[60,90]], 'mg/L', .99)], None
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.png'
            cv2.imwrite(str(path), np.full((150, 400, 3), 255, dtype=np.uint8))
            # Distinct crops survive geometric deduplication but share one cell.
            with patch.object(worker, 'header_retry_regions', return_value=[region, {**region, 'crop': (190, 35, 280, 75)}]):
                budget = worker.empty_retry_budget()
                result, attempts = worker.retry_missing_header_cells(engine, path, [original], budget)
            self.assertEqual(result[0]['text'], 'mg/L')
            self.assertEqual(len(attempts), 2)
            self.assertEqual(budget['cellRemaining'], 0)
            self.assertEqual(budget['cellUnresolved'], 0)

    def test_pdf_fusion_keeps_repeated_results_units_and_signs_at_distinct_positions(self):
        source = [ocr_line(text, 1, 10, index * 30, 50, index * 30 + 20)
                  for index, text in enumerate(["0", "0", "-", "-", "U/L", "U/L", "+", "±"])]
        duplicates = [{**line, "confidence": .9} for line in source]
        fused = worker.merge_pdf_text_and_ocr_lines(source, duplicates)
        self.assertEqual([line["text"] for line in fused], [line["text"] for line in source])
        self.assertEqual(len(set(line["id"] for line in fused)), len(source))

    def test_pdf_fusion_keeps_unknown_position_and_conflicting_text(self):
        pdf = [ocr_line("0", 1, 0, 0, 20, 20)]
        ocr = [ocr_line("8", .9, 0, 0, 20, 20), {"text":"0", "confidence":.9}]
        self.assertEqual(len(worker.merge_pdf_text_and_ocr_lines(pdf, ocr)), 3)

    def test_structure_annotations_return_to_original_pdf_coordinates(self):
        from unittest.mock import patch
        source = [{"id":"a", "text":"synthetic", "box":[10,20,30,40]}]
        def annotate(path, lines):
            self.assertEqual(lines[0]["box"], [30,60,90,120])
            return [{**lines[0], "tableCell":{"table":"table_0", "row":0, "column":0, "columns":2}}]
        with patch("table_structure.enhance", side_effect=annotate):
            result = worker.enhance_page_lines(Path("unused"), source, 3)
        self.assertEqual(result[0]["box"], source[0]["box"])
        self.assertIn("tableCell", result[0])
        self.assertNotIn("tableCell", source[0])

    def test_auto_backend_prefers_onnxruntime_on_arm64(self):
        self.assertEqual(
            worker.backend_candidates(machine="aarch64"),
            ["onnxruntime", "openvino"],
        )
        self.assertEqual(
            worker.backend_candidates(machine="x86_64"),
            ["openvino", "onnxruntime"],
        )

    def test_explicit_backend_is_not_overridden_by_architecture(self):
        self.assertEqual(
            worker.backend_candidates("openvino", "aarch64"),
            ["openvino"],
        )

    def test_onnx_threads_keep_onnxruntime_default_off_arm(self):
        from unittest.mock import patch

        with patch("platform.machine", return_value="x86_64"):
            self.assertEqual(worker.onnx_engine_kwargs(), {})

    def test_onnx_threads_leave_one_core_for_the_system_on_arm(self):
        from unittest.mock import patch

        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=4):
            self.assertEqual(
                worker.onnx_engine_kwargs(),
                {"intra_op_num_threads": 3, "inter_op_num_threads": 1},
            )
        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=1):
            self.assertEqual(worker.onnx_engine_kwargs()["intra_op_num_threads"], 1)
        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=16):
            self.assertEqual(worker.onnx_engine_kwargs()["intra_op_num_threads"], 4)

    def test_onnx_threads_environment_override_wins_everywhere(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"OCR_WORKER_ONNX_INTRA_OP_THREADS": "2", "OCR_WORKER_ONNX_INTER_OP_THREADS": "2"}):
            self.assertEqual(
                worker.onnx_engine_kwargs(),
                {"intra_op_num_threads": 2, "inter_op_num_threads": 2},
            )
        with patch.dict(os.environ, {"OCR_WORKER_ONNX_INTRA_OP_THREADS": "0"}):
            self.assertEqual(worker.onnx_engine_kwargs(), {})

    def test_detects_missing_and_corrupted_double_column_results(self):
        lines = [
            ocr_line("白细胞数(WBC)", 0.97, 80, 60, 260, 90),
            ocr_line("5.0", 0.99, 520, 60, 570, 90),
            ocr_line("3.5-9.5", 0.99, 720, 60, 810, 90),
            ocr_line("中性粒细胞百分比(NEUT%)", 0.95, 80, 100, 390, 130),
            ocr_line("40-75", 0.99, 720, 100, 805, 130),
            ocr_line("血小板体积分布宽度(PDW)", 0.95, 870, 100, 1160, 130),
            ocr_line("↑76", 0.82, 1300, 100, 1360, 130),
            ocr_line("9.8-15.2", 0.99, 1500, 100, 1600, 130),
            ocr_line("平均血小板体积(MPV)", 0.96, 870, 140, 1120, 170),
            ocr_line("9.1", 0.99, 1300, 140, 1360, 170),
            ocr_line("9.1-12.0", 0.99, 1500, 140, 1600, 170),
        ]

        rows = worker.suspicious_table_rows(lines, 1737, 1227)

        self.assertEqual(
            [row["name"]["text"] for row in rows],
            ["中性粒细胞百分比(NEUT%)", "血小板体积分布宽度(PDW)"],
        )
        self.assertIsNone(rows[0]["result"])
        self.assertEqual(rows[1]["result"]["text"], "↑76")

    def test_combines_retry_marker_with_same_variant_only(self):
        lines = [
            ocr_line("9.2", 0.99, 100, 10, 150, 40, "gray"),
            ocr_line("↓", 0.80, 145, 10, 170, 40, "gray"),
            ocr_line("↑", 0.95, 145, 10, 170, 40, "red"),
        ]

        combined = worker.combine_retry_result_markers(lines)

        self.assertIn("9.2↓", [line["text"] for line in combined])
        self.assertNotIn("9.2↑", [line["text"] for line in combined])

    def test_numeric_consensus_is_not_weakened_by_an_uncertain_arrow(self):
        lines = [ocr_line('12.5', .99, 100, 10, 150, 40, variant)
                 for variant in ['gray', 'upscale']]
        lines += [ocr_line('↓', .55, 150, 10, 170, 40, variant)
                  for variant in ['gray', 'upscale']]
        self.assertIsNotNone(worker.consensus_retry_result(worker.combine_retry_result_markers(lines)))

    def test_joined_decimals_supersede_their_partial_numeric_fragments(self):
        lines = [line for variant in ['gray', 'upscale'] for line in
                 [ocr_line('12', .99, 100, 10, 130, 40, variant),
                  ocr_line('.5', .99, 131, 10, 145, 40, variant)]]
        result = worker.consensus_retry_result(worker.combine_retry_result_markers(lines))
        self.assertEqual(result['text'], '12.5')

    def test_overlapping_decimal_fragments_do_not_repeat_shared_digits(self):
        lines = [line for variant in ['gray', 'upscale'] for line in
                 [ocr_line('12', .99, 100, 10, 145, 40, variant),
                  ocr_line('2.5', .99, 132, 10, 180, 40, variant)]]
        lines += [ocr_line('12.5', .99, 100, 10, 180, 40, 'wide')]
        result = worker.consensus_retry_result(worker.combine_retry_result_markers(lines))
        self.assertEqual(result['text'], '12.5')

    def test_unit_labels_are_not_short_english_project_names(self):
        for text in ['fL', 'pg', 'g/L', 'mL']:
            self.assertTrue(worker.standalone_unit(text))
            self.assertEqual(worker.suspicious_table_rows([
                ocr_line(text,.99,10,50,100,70),ocr_line('12.5',.5,200,50,260,70)],800,500),[])
        self.assertFalse(worker.standalone_unit('ALT'))

    def test_complete_decimal_scores_above_truncated_candidate(self):
        reference = (40.0, 75.0)
        truncated = ocr_line("39", 0.99, 10, 10, 40, 40)
        complete = ocr_line("39.3", 0.90, 10, 10, 50, 40)

        self.assertGreater(
            worker.retry_result_score(complete, reference),
            worker.retry_result_score(truncated, reference),
        )

    def test_detects_suspicious_rows_in_parenthesized_wide_layout(self):
        # 括号包裹参考值 + 名称列与参考值列分处两端的宽版式检验单
        lines = [
            ocr_line("★甘油三酯", 0.95, 12, 859, 77, 879),
            ocr_line("1.89(mmolL)↑", 0.83, 352, 859, 454, 879),
            ocr_line("(0.3-1.71)", 0.99, 1099, 860, 1160, 880),
            ocr_line("★白蛋白", 0.97, 12, 900, 77, 920),
            ocr_line("48.3 (g/L)", 0.96, 352, 900, 460, 920),
            ocr_line("(35-50)", 0.99, 1099, 900, 1160, 920),
        ]

        rows = worker.suspicious_table_rows(lines, 1170, 1120)

        self.assertEqual([row["name"]["text"] for row in rows], ["★甘油三酯"])
        self.assertTrue(rows[0]["resultSuspicious"])
        self.assertEqual(rows[0]["result"]["text"], "1.89(mmolL)↑")

    def test_restores_inline_unit_from_retry_lines(self):
        retry_lines = [ocr_line("mmol/L", 0.84, 360, 859, 450, 879, "table_upscale")]

        restored = worker.restore_inline_unit("1.89(mmolL)↑", "1.89↑", retry_lines)

        self.assertEqual(restored, "1.89(mmol/L)↑")

    def test_restores_inline_unit_falls_back_to_original_unit(self):
        restored = worker.restore_inline_unit("1.89(mmolL)↑", "1.89↑", [])

        self.assertEqual(restored, "1.89(mmolL)↑")

    def test_restore_inline_unit_keeps_text_without_unit(self):
        restored = worker.restore_inline_unit("1.89↑", "1.90↑", [])

        self.assertEqual(restored, "1.90↑")

    def test_extreme_value_row_is_marked_check_only_not_corrupt(self):
        # 真实的重症异常（72.0，参考 0.4~8）：超上限 3 倍触发核对，但不是损坏行
        lines = [
            ocr_line("嗜酸性细胞百分数(EOS%)", 0.98, 96, 638, 388, 664),
            ocr_line("72.0", 1.00, 609, 636, 666, 660),
            ocr_line("%", 0.99, 775, 636, 790, 660),
            ocr_line("0.4~8", 0.99, 991, 635, 1040, 660),
        ]

        rows = worker.suspicious_table_rows(lines, 1352, 1920)

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["resultSuspicious"])
        self.assertTrue(rows[0]["resultExtreme"])
        self.assertFalse(rows[0]["resultCorrupt"])

    def test_extreme_value_retry_never_prefers_normal_values(self):
        row = {"reference": (0.4, 8.0), "resultExtreme": True, "resultCorrupt": False}
        # 重读给出反向越界值（72.0→0）：拒绝替换，保留原始读数
        self.assertFalse(worker.retry_replacement_allowed(row, 0.0))
        self.assertFalse(worker.retry_replacement_allowed(row, None))
        # 回落参考范围不能证明 OCR 更准确：同样拒绝替换
        self.assertFalse(worker.retry_replacement_allowed(row, 5.2))
        # 损坏形态的行不受限制，维持原替换逻辑
        corrupt = {"reference": (0.4, 8.0), "resultExtreme": True, "resultCorrupt": True}
        self.assertTrue(worker.retry_replacement_allowed(corrupt, 0.0))


class MicroscopyIntervalTest(unittest.TestCase):
    def fixture(self, dash=True, value='48', unit='/HP'):
        import cv2
        import numpy as np
        image=np.full((140,650,3),255,dtype=np.uint8)
        cv2.line(image,(253,64),(253,76),(0,0,0),2)
        cv2.line(image,(284,64),(284,76),(0,0,0),2)
        if dash: cv2.line(image,(265,70),(274,70),(0,0,0),1)
        lines=[ocr_line('项目',.99,20,10,90,30),ocr_line('结果',.99,250,10,300,30),
               ocr_line('单位',.99,420,10,470,30),ocr_line('Synthetic',.99,20,60,150,80),
               ocr_line(value,.99,250,60,290,80),ocr_line(unit,.99,420,60,470,80)]
        return image,lines

    def test_only_independent_dash_pixels_in_unique_microscopy_result_trigger(self):
        image,lines=self.fixture()
        self.assertEqual(len(worker.microscopy_interval_rows(lines,image)),1)
        no_dash,_=self.fixture(False)
        self.assertEqual(worker.microscopy_interval_rows(lines,no_dash),[])
        for value in ['4.8','<48','-48','4-8','8']:
            im,ls=self.fixture(value=value)
            self.assertEqual(worker.microscopy_interval_rows(ls,im),[])
        for unit in ['U/L','mg/L','/unknown']:
            im,ls=self.fixture(unit=unit)
            self.assertEqual(worker.microscopy_interval_rows(ls,im),[])
        for extra in [ocr_line('结果',.99,330,10,380,30),ocr_line('上次结果',.99,330,10,400,30),
                      ocr_line('2026-01-03',.99,330,10,410,30)]:
            self.assertEqual(worker.microscopy_interval_rows([*lines,extra],image),[])
        self.assertEqual(worker.microscopy_interval_rows(lines[3:],image),[])

    def test_interval_consensus_preserves_digits_and_rejects_conflicting_or_unlocated_readings(self):
        _,lines=self.fixture();original=lines[4]
        a=ocr_line('4-8',.99,250,60,290,80,'rgb')
        b=ocr_line('4-8',.98,250,60,290,80,'gray')
        self.assertEqual(worker.consensus_retry_interval([a,b],original)['text'],'4-8')
        for bad in [ocr_line('4-7',.99,250,60,290,80,'gray'),ocr_line('48',.99,250,60,290,80,'gray'),
                    ocr_line('4-8',.99,250,100,290,120,'gray'),{**b,'variant':'rgb'}, {**b,'confidence':.5}]:
            self.assertIsNone(worker.consensus_retry_interval([a,bad],original))

    def test_retry_is_bounded_and_unresolved_pixels_cannot_publish_a_confident_integer(self):
        import cv2
        import tempfile
        from copy import deepcopy
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'synthetic.png';image,lines=self.fixture();cv2.imwrite(str(path),image)
            saved=deepcopy(lines)
            calls=[]
            def engine(value):
                calls.append(value)
                return [[[[54,36],[174,36],[174,96],[54,96]],'4-8',.99]],None
            result,_=worker.retry_suspicious_table_rows(engine,path,lines)
            self.assertEqual(len(calls),2)
            self.assertTrue(any(line['text']=='4-8' for line in result))
            self.assertFalse(any(line['text']=='48' for line in result))
            self.assertEqual(lines,saved)
            for limit in [0,1,2]:
                context=worker.PageRetryContext();context.budget['retryCallLimit']=limit
                result,_=worker.retry_suspicious_table_rows(lambda path:([],None),path,lines,retry_context=context)
                unresolved=next(line for line in result if line['text']=='48')
                self.assertLess(unresolved['confidence'],.65)
                self.assertLessEqual(context.budget['retryCalls'],limit)
            no_dash,_=self.fixture(False);cv2.imwrite(str(path),no_dash)
            result,attempts=worker.retry_suspicious_table_rows(engine,path,lines)
            self.assertEqual(attempts,[])
            self.assertEqual(result,lines)


if __name__ == "__main__":
    unittest.main()
