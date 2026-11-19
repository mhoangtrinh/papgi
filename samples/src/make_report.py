"""Word-style sample: build a .docx with python-docx, then convert with LibreOffice (soffice) to ../../public/samples/report.pdf"""
import subprocess, shutil, os
from docx import Document
from docx.shared import Pt
d = Document()
st = d.styles['Normal']; st.font.name = 'Calibri'; st.font.size = Pt(11)
d.add_heading('Quarterly Project Report', level=1)
p = d.add_paragraph('This report summarises the progress of the ')
r = p.add_run('measurement campaign'); r.bold = True
p.add_run(' during the third quarter. All results are preliminary and will be checked again before the final review meeting in December. The team thanks everyone who contributed to the setup of the lab.')
d.add_heading('Results', level=2)
d.add_paragraph('The noise floor improved by 6 dB after the shielding was replaced. Power consumption stayed within the budget of 2 mW for all twenty samples.')
d.add_paragraph('First bullet item with some text', style='List Bullet')
d.add_paragraph('Second bullet item that is a bit longer so that it wraps onto the next line of the page', style='List Bullet')
t = d.add_table(rows=2, cols=3); t.style = 'Table Grid'
for i, row in enumerate(t.rows):
    for j, c in enumerate(row.cells): c.text = f'Cell {i}{j}'
d.add_paragraph('Signed: Hoang Trinh, Aachen, 19 November 2026')
d.save('report.docx')
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', 'report.docx'], check=True, capture_output=True)
shutil.move('report.pdf', '../../public/samples/report.pdf')
os.remove('report.docx')
