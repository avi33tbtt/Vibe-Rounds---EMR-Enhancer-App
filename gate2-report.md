# Gate 2 report: slot example from 7.1 over every seed set (20 Nov 2026)

Slots: value = Observation, quantity, any unit. when = time, same row as value. No codes bound, no manual bindings.

## disease.snake_envenomation

- **value**: unmet
- **when**: unmet
- unused fields: bite, arr, asv, wbct, swell, vials, out

## disease.dka

- **value**: unmet
- **when**: unmet
- unused fields: arr, ins, glu, ph, hco3, k, ket, gcs, fl, out

## care.vitals

- **value**: met
  - temp (matched on: Observation, quantity, °C)
  - hr (matched on: Observation, quantity, bpm)
  - rr (matched on: Observation, quantity, /min)
  - bp_sys (matched on: Observation, quantity, mmHg)
  - bp_dia (matched on: Observation, quantity, mmHg)
  - spo2 (matched on: Observation, quantity, %)
  - weight (matched on: Observation, quantity, kg)
- **when**: met
  - vit_time (matched on: time, no unit; same row as value)
- unused fields: none

## template.basic_emr

- **value**: unmet
- **when**: unmet
- unused fields: cc, hx, exam, assess, plan

## care.hba1c_monitoring

- **value**: met
  - a1c (matched on: Observation, quantity, %)
  - cbg (matched on: Observation, quantity, mg/dL)
- **when**: met
  - a1c_date (matched on: time, no unit; same row as value)
  - cbg_time (matched on: time, no unit; same row as value)
- unused fields: a1c_target, a1c_due

## care.sliding_scale_insulin

- **value**: met
  - ssi_glucose (matched on: Observation, quantity, mg/dL)
- **when**: met
  - ssi_time (matched on: time, no unit; same row as value)
- unused fields: ssi_dose, ssi_by

## care.fever_chart

- **value**: met
  - temp (matched on: Observation, quantity, unit varies by row)
  - pulse (matched on: Observation, quantity, bpm)
- **when**: met
  - ft_time (matched on: time, no unit; same row as value)
- unused fields: route, antipyretic

## care.daily_insulin_monitoring

- **value**: met
  - ins_glucose (matched on: Observation, quantity, mg/dL)
- **when**: met
  - ins_time (matched on: time, no unit; same row as value)
- unused fields: slot, ins_dose, ins_by, ins_note

## care.intake_output

- **value**: met
  - io_volume (matched on: Observation, quantity, mL)
- **when**: met
  - io_time (matched on: time, no unit; same row as value)
- unused fields: io_type, io_note

