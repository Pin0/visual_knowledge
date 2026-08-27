h1. Visual Knowledge Browser

Live demo: https://pin0.github.io/visual_knowledge/

Based on ASK KEN™ - Visual Knowledge Browser from 17 jears ago. (example folder)

This tool allows users to explore linked data (triples) in a visual way

Each entity is presented as a circular node (see example_donut folder) Where the string literals are presented in the internal circle, the uris (links to other entities) are presented in the external circle. As well as the relations. (relations can be search by posting to /search/records searching for field _link with the uri of the entity)

This tool allows users to explore data coming from api's like: https://id.archief.amsterdam/docs/openapi/

It's a javascript frontend only. The base url can be hardcoded. 