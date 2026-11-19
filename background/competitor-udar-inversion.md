# Competitor background: UDAR inversion for geosteering

## Source

John Zhou and Shanjun Li, “Independent Inversion and Interpretation of UDAR Data for Enhanced Geosteering.” Prepared for the SPWLA 1st UDAR Topical Conference, London, UK, March 23–25, 2026. Maxwell Dynamics, Inc.

The supplied source file is `2026_UDAR_SPWLA_TOP_4771_John Zhou.docx`. Its first page states that copyright is held jointly by SPWLA and the submitting authors. This note summarizes the paper; the paper itself is not included in this repository. The document does not provide a DOI or proceedings page range.

## What the paper describes

The authors present a vendor-independent UDAR inversion platform and argue that inversion should complement conventional log correlation, rather than replace it. The proposed workflow first correlates conventional logs from a pilot and horizontal well to create a geological cross-section, then uses UDAR inversion to refine the model and reconcile it with that cross-section.

The inversion uses a layered-earth model with the tool between interfaces, and can include formation anisotropy. The objective combines measured and modeled responses with constraints on model updates, resistivity, bed thickness, interface orientation, and anisotropy. The paper describes deterministic and stochastic search, multiple random seeds, increasing model complexity, and parallelized forward modeling.

## Case-study claims and caveats

The paper presents an after-drill interpretation of a deepwater horizontal well, with a pilot well on the same platform. It reports qualitative examples where UDAR responses indicate stable boundary distances, an approaching boundary, closer boundary proximity, and a possible thin shale interval. Some intervals remain ambiguous; the authors mention possible 3D and anisotropy effects. They use the inversion curtain to revise an ambiguous correlation model and describe resolution indicators for judging inverted parameters.

These are qualitative case-study observations, not a numerical benchmark. The reviewed paper text gives no quantitative accuracy, runtime, or comparative validation metrics. It also discusses inversion non-uniqueness and dependence on adequate measurements, initial seeds, model constraints, and the assumed layered geometry. The case study is after-drill and does not by itself demonstrate real-time operational performance.

## Relationship to this repository

The repository describes an Ekofisk release of eleven DLIS runs from ten wellbores, with 2 MHz, 500 kHz, and 125 kHz resistivity measurements, azimuthal channels, geosignals, conventional logs, and well paths. The paper describes 400 kHz and 2 MHz UDAR measurements, directional and harmonic measurements, and a pilot-well dataset. It does not name Ekofisk or identify the release in this repository as its source; the paper also mentions additional measurements from the lateral and pilot well. There is therefore no evidence in the paper that its case study uses these repository data.

The paper is relevant as background on a competing interpretation approach: it treats inversion as a way to add local boundary geometry to a broader correlation-derived model. The repository currently documents and distributes measurements and a visualization notebook; it does not implement the inversion workflow described in the paper. Do not treat the paper's qualitative case-study claims as validation of any inversion applied to this dataset.

## References listed in the paper

The paper's references include Bittar et al. (2009), “A New Azimuthal Deep-Reading Resistivity Tool for Geosteering and Advanced Formation Evaluation”; Rabinovich et al. (2024), “Is UDAR technology ready for 3D environment?”; Sinha et al. (2022), a Norwegian Continental Shelf case history; and Bergeron et al. (2022), “UDAR: Past, Present, and Future.”
